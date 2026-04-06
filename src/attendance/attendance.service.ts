import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, timer, throwError, retry } from 'rxjs';

@Injectable()
export class AttendanceService {
  // ── VARIABEL CACHING ──
  private cachedShifts: { data: any; time: number } | null = null;
  private cachedLeaveTypes: { data: any; time: number } | null = null;
  private cachedAllLeaves: { data: any; time: number } | null = null;
  // Cache getAllHistory: key = "from|to"
  private cachedAllHistory: Map<string, { data: any; time: number }> = new Map();
  // Cache shift locations: key = shift_name
  private cachedShiftLocations: Map<string, { data: any; time: number }> = new Map();

  private readonly SHIFT_CACHE_TTL   = 2 * 60 * 1000;  // 2 menit
  private readonly CACHE_TTL         = 60 * 60 * 1000;  // 1 jam
  private readonly HISTORY_CACHE_TTL = 2 * 60 * 1000;   // 2 menit
  private readonly LEAVE_CACHE_TTL   = 3 * 60 * 1000;   // 3 menit

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Auth header
  // ─────────────────────────────────────────────────────────────────
  private getAuth() {
    const erpUrl    = this.configService.get<string>('ERPNEXT_URL')        ?? '';
    const apiKey    = this.configService.get<string>('ERPNEXT_API_KEY')    ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';
    return { erpUrl, authHeader: `token ${apiKey}:${apiSecret}` };
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Dapatkan tanggal WIB hari ini (YYYY-MM-DD)
  // ─────────────────────────────────────────────────────────────────
  private getTodayWib(): string {
    const nowUtc  = new Date();
    const wibTime = new Date(nowUtc.getTime() + 7 * 60 * 60 * 1000);
    const yyyy    = wibTime.getUTCFullYear();
    const mm      = String(wibTime.getUTCMonth() + 1).padStart(2, '0');
    const dd      = String(wibTime.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Normalisasi nama shift kantor ke format ERPNext
  // ─────────────────────────────────────────────────────────────────
  private normalizeOfficeShiftName(shiftName: string): string {
    if (!shiftName) return shiftName;
    let name = shiftName.trim().replace(/\s+Satpam\s*$/i, '').trim();
    if (name.includes('(') && name.includes(')')) return name;

    const isFriday   = /^jumat/i.test(name);
    const isRamadhan = /ramadhan/i.test(name);
    const isJakarta  = /jakarta/i.test(name);

    const hariPart    = isFriday ? 'Jumat' : 'Senin - Kamis';
    const branchPart  = isJakarta ? 'Jakarta' : 'PH Klaten';
    const periodePart = isRamadhan ? 'Ramadhan' : 'Non Ramadhan';

    return `${hariPart} (${branchPart} ${periodePart})`;
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Cek apakah shift name adalah shift kantor (bukan outlet)
  // ─────────────────────────────────────────────────────────────────
  private isOfficeShift(shiftName: string): boolean {
    if (!shiftName) return false;
    const lower = shiftName.toLowerCase();
    return (
      lower.includes('senin') ||
      lower.includes('jumat') ||
      lower.includes('ph klaten') ||
      lower.includes('jakarta')
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Cek apakah Shift Assignment sudah ada untuk hari ini
  // ─────────────────────────────────────────────────────────────────
  private async hasExistingShiftAssignment(
    erpUrl: string,
    authHeader: string,
    employeeId: string,
    shiftType: string,
    dateStr: string,
  ): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Assignment`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['employee',   '=',  employeeId],
              ['shift_type', '=',  shiftType],
              ['start_date', '<=', dateStr],
              ['docstatus',  'in', [0, 1]],
            ]),
            fields:            JSON.stringify(['name', 'start_date', 'end_date', 'docstatus']),
            limit_page_length: 50,
            _t: Date.now(),
          },
        }).pipe(
          retry({
            count: 2,
            delay: (error, retryCount) => {
              if (error.response && error.response.status >= 400 && error.response.status < 500) return throwError(() => error);
              return timer(retryCount * 1000);
            }
          })
        )
      );

      const assignments: any[] = res.data.data ?? [];
      return assignments.some((a) => {
        if (!a.end_date) return true;
        return a.end_date >= dateStr;
      });
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // CORE: Buat dan Submit Shift Assignment otomatis
  // ─────────────────────────────────────────────────────────────────
  private async ensureShiftAssignment(
    erpUrl: string,
    authHeader: string,
    employeeId: string,
    shiftType: string,
    dateStr: string,
  ): Promise<{ created: boolean; docName: string | null; error?: string }> {
    try {
      const alreadyExists = await this.hasExistingShiftAssignment(
        erpUrl, authHeader, employeeId, shiftType, dateStr,
      );

      if (alreadyExists) return { created: false, docName: null };

      const createPayload = {
        employee:   employeeId,
        shift_type: shiftType,
        start_date: dateStr,
        end_date:   dateStr,
        docstatus:  0,
      };

      const createRes = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Shift Assignment`,
          createPayload,
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ).pipe(
          retry({
            count: 2,
            delay: (error, retryCount) => {
              if (error.response && error.response.status >= 400 && error.response.status < 500) return throwError(() => error);
              return timer(retryCount * 1000);
            }
          })
        )
      );

      const docName: string = createRes.data.data.name;

      await firstValueFrom(
        this.httpService.put(
          `${erpUrl}/api/resource/Shift Assignment/${encodeURIComponent(docName)}`,
          { docstatus: 1 },
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ).pipe(
          retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) })
        )
      );

      return { created: true, docName };
    } catch (error: any) {
      const errMsg = JSON.stringify(error.response?.data || error.message);
      console.error('[ShiftAssignment] Gagal:', errMsg);
      return { created: false, docName: null, error: errMsg };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Ambil detail jam Shift Type dari ERPNext
  // ─────────────────────────────────────────────────────────────────
  private async getShiftTypeDetail(
    erpUrl: string,
    authHeader: string,
    shiftType: string,
  ): Promise<{ shift_name: string; start_time: string; end_time: string } | null> {
    try {
      const res = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Shift Type/${encodeURIComponent(shiftType)}`,
          { headers: { Authorization: authHeader } },
        ).pipe(
          retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) })
        )
      );
      const d = res.data.data;
      const fmt = (raw: string | null): string => {
        if (!raw) return '00:00';
        const parts = raw.split(' ');
        return parts[parts.length - 1].substring(0, 5);
      };
      return { shift_name: shiftType, start_time: fmt(d.start_time), end_time: fmt(d.end_time) };
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET ACTIVE SHIFT
  // REVISI: Setelah dapat detail shift, langsung fetch lokasi shift
  // (via getShiftLocations) dan merge ke response. Frontend outlet
  // akan menerima koordinat lokasi yang harus divalidasi GPS-nya,
  // sehingga tidak perlu request terpisah.
  //
  // Response tambahan:
  //   - location_name?  : nama lokasi shift (dari Shift Location ERPNext)
  //   - location_lat?   : latitude lokasi
  //   - location_lng?   : longitude lokasi
  //   - location_radius?: radius geofence (meter)
  // ─────────────────────────────────────────────────────────────────
  async getActiveShift(employeeId: string) {
    const { erpUrl, authHeader } = this.getAuth();
    const todayStr = this.getTodayWib();

    try {
      // ── Step 1: Cari Shift Assignment aktif ──────────────────────
      const assignRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Assignment`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['employee',   '=',  employeeId],
              ['start_date', '<=', todayStr],
              ['docstatus',  '=',  1],
            ]),
            fields:            JSON.stringify(['name', 'shift_type', 'start_date', 'end_date']),
            order_by:          'start_date desc',
            limit_page_length: 50,
            _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const assignments: any[] = assignRes.data.data ?? [];
      const aktifAssignment = assignments.find((a) => {
        if (!a.end_date) return true;
        return a.end_date >= todayStr;
      });

      if (aktifAssignment) {
        const detail = await this.getShiftTypeDetail(erpUrl, authHeader, aktifAssignment.shift_type);
        if (detail) {
          // REVISI: Fetch lokasi shift sekaligus, merge ke response
          const lokasiResult = await this.getShiftLocations(aktifAssignment.shift_type);
          const lokasi = lokasiResult.locations?.[0] ?? null;

          return {
            success:         true,
            source:          'assignment',
            ...detail,
            // Field lokasi — null jika shift tidak punya lokasi di ERPNext
            location_name:   lokasi?.nama   ?? null,
            location_lat:    lokasi?.lat    ?? null,
            location_lng:    lokasi?.lng    ?? null,
            location_radius: lokasi?.radius ?? null,
          };
        }
      }

      // ── Step 2: Fallback ke Shift Request ────────────────────────
      const reqRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Request`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['employee',  '=',  employeeId],
              ['from_date', '<=', todayStr],
              ['status',    '=',  'Approved'],
              ['docstatus', '=',  1],
            ]),
            fields:            JSON.stringify(['name', 'shift_type', 'from_date', 'to_date']),
            order_by:          'from_date desc',
            limit_page_length: 50,
            _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const requests: any[] = reqRes.data.data ?? [];
      const aktifRequest = requests.find((r) => {
        if (!r.to_date) return true;
        return r.to_date >= todayStr;
      });

      if (aktifRequest) {
        const detail = await this.getShiftTypeDetail(erpUrl, authHeader, aktifRequest.shift_type);
        if (detail) {
          // REVISI: Fetch lokasi shift sekaligus, merge ke response
          const lokasiResult = await this.getShiftLocations(aktifRequest.shift_type);
          const lokasi = lokasiResult.locations?.[0] ?? null;

          return {
            success:         true,
            source:          'request',
            ...detail,
            location_name:   lokasi?.nama   ?? null,
            location_lat:    lokasi?.lat    ?? null,
            location_lng:    lokasi?.lng    ?? null,
            location_radius: lokasi?.radius ?? null,
          };
        }
      }

      return { success: false, message: 'Belum ada Shift. Silakan Ajukan Shift ke HRD.' };

    } catch (error: any) {
      return { success: false, message: 'Gagal membaca Shift dari ERPNext.' };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // UPLOAD BASE64 MENJADI FILE FISIK KE ERPNEXT
  // ─────────────────────────────────────────────────────────────────
  private async uploadBase64ToERPNext(
    erpUrl: string,
    authHeader: string,
    base64Data: string | undefined | null,
    fileNamePrefix: string,
  ): Promise<string | null> {
    if (!base64Data || !base64Data.startsWith('data:image')) return null;

    try {
      const matches = base64Data.match(/^data:([A-Za-z0-9+\/]+\/[A-Za-z0-9+\/]+);base64,(.+)$/);
      if (!matches) return null;

      const mimeType   = matches[1];
      const fileBuffer = Buffer.from(matches[2], 'base64');
      const extMap: Record<string, string> = {
        'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
        'image/gif':  'gif', 'image/webp': 'webp',
      };
      const ext          = extMap[mimeType] ?? 'jpg';
      const safeFileName = `${fileNamePrefix}_${Date.now()}.${ext}`;
      const boundary     = `----FormBoundary${Date.now()}`;

      const beforeFile = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${safeFileName}"`,
        `Content-Type: ${mimeType}`,
        '', '',
      ].join('\r\n');

      const afterFile = [
        '',
        `--${boundary}`,
        `Content-Disposition: form-data; name="is_private"`,
        '', '0',
        `--${boundary}--`, '',
      ].join('\r\n');

      const bodyBuffer = Buffer.concat([
        Buffer.from(beforeFile, 'utf-8'),
        fileBuffer,
        Buffer.from(afterFile, 'utf-8'),
      ]);

      const res = await firstValueFrom(
        this.httpService.post(`${erpUrl}/api/method/upload_file`, bodyBuffer, {
          headers: {
            Authorization:   authHeader,
            'Content-Type':  `multipart/form-data; boundary=${boundary}`,
            'Content-Length': bodyBuffer.length.toString(),
          },
        }).pipe(
          retry({
            count: 3,
            delay: (error, retryCount) => {
              if (error.response && error.response.status >= 400 && error.response.status < 500) {
                return throwError(() => error);
              }
              console.warn(`[Auto-Retry] Server ERP sibuk saat upload foto, mencoba ulang ke-${retryCount}...`);
              return timer(retryCount * 1500);
            }
          })
        )
      );

      return res.data.message.file_url;
    } catch (err: any) {
      console.error(`[Upload File Gagal untuk ${fileNamePrefix}]:`, err.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // CREATE CHECKIN (HANYA FOTO, TANPA TTD)
  // ─────────────────────────────────────────────────────────────────
  async createCheckin(data: any) {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const nowUtc     = new Date();
      const wibTime    = new Date(nowUtc.getTime() + 7 * 60 * 60 * 1000);
      const timeString = wibTime.toISOString().replace('T', ' ').substring(0, 19);
      const todayStr   = this.getTodayWib();

      const inputTipe = (data.tipe || data.log_type || '').toUpperCase();
      const logType   = (inputTipe === 'KELUAR' || inputTipe === 'OUT') ? 'OUT' : 'IN';

      let shiftName: string = data.shift ?? '';
      if (shiftName && this.isOfficeShift(shiftName)) {
        shiftName = this.normalizeOfficeShiftName(shiftName);
      }

      let shiftAssignmentInfo: { created: boolean; docName: string | null; error?: string } =
        { created: false, docName: null };

      if (logType === 'IN' && shiftName) {
        shiftAssignmentInfo = await this.ensureShiftAssignment(
          erpUrl, authHeader, data.employee_id, shiftName, todayStr,
        );
      }

      const [fotoAbsenUrl, fotoKiriUrl] = await Promise.all([
        this.uploadBase64ToERPNext(erpUrl, authHeader, data.image_verification, `Absen_${data.employee_id}_Depan`),
        this.uploadBase64ToERPNext(erpUrl, authHeader, data.custom_verification_image, `Absen_${data.employee_id}_Kiri`),
      ]);

      const payload: any = {
        employee:                  data.employee_id,
        log_type:                  logType,
        time:                      timeString,
        latitude:                  data.latitude,
        longitude:                 data.longitude,
        custom_foto_absen:         fotoAbsenUrl || data.image_verification,
        custom_verification_image: fotoKiriUrl  || data.custom_verification_image,
        shift:                     shiftName,
        device_id:                 'RopiHR-PWA',
      };

      const response = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Employee Checkin`,
          payload,
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ).pipe(
          retry({
            count: 3,
            delay: (error, retryCount) => {
              if (error.response && error.response.status >= 400 && error.response.status < 500) {
                return throwError(() => error);
              }
              console.warn(`[Auto-Retry] Server ERP sibuk saat proses absen, mencoba ulang ke-${retryCount}...`);
              return timer(retryCount * 1500);
            }
          })
        )
      );

      return {
        success:                  true,
        message:                  `Absen ${logType === 'IN' ? 'MASUK' : 'KELUAR'} berhasil!`,
        data:                     response.data.data,
        shift_assignment_created: shiftAssignmentInfo.created,
        shift_assignment_doc:     shiftAssignmentInfo.docName,
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      console.error('Checkin Error:', error.response?.data || error.message);
      throw new HttpException(
        'Gagal menyimpan absen ke sistem HR.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET HISTORY
  // ─────────────────────────────────────────────────────────────────
  async getHistory(employeeId: string, from: string, to: string) {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Employee Checkin`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['employee', '=', employeeId],
              ['time',     '>=', `${from} 00:00:00`],
              ['time',     '<=', `${to} 23:59:59`],
            ]),
            fields: JSON.stringify([
              'name', 'employee', 'log_type', 'time',
              'custom_foto_absen', 'shift',
              'custom_verification_image', 'latitude', 'longitude',
            ]),
            order_by:          'time desc',
            limit_page_length: 100,
            _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );
      return { success: true, data: response.data.data };
    } catch {
      throw new HttpException('Gagal mengambil riwayat absen dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET ALL HISTORY (HR Dashboard)
  // ─────────────────────────────────────────────────────────────────
  async getAllHistory(from: string, to: string) {
    const cacheKey = `${from}|${to}`;
    const now      = Date.now();
    const cached   = this.cachedAllHistory.get(cacheKey);
    if (cached && (now - cached.time < this.HISTORY_CACHE_TTL)) {
      return { success: true, data: cached.data };
    }

    const { erpUrl, authHeader } = this.getAuth();

    try {
      const absensiReq = firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Employee Checkin`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['time', '>=', `${from} 00:00:00`],
              ['time', '<=', `${to} 23:59:59`],
            ]),
            fields: JSON.stringify([
              'name', 'employee', 'employee_name', 'log_type', 'time',
              'custom_foto_absen', 'shift',
              'latitude', 'longitude',
            ]),
            order_by:          'time desc',
            limit_page_length: 2000,
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const leaveReq = firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['docstatus', 'in', [0, 1]],
              ['from_date', '<=', to],
              ['to_date',   '>=', from],
            ]),
            fields: JSON.stringify([
              'name', 'employee', 'employee_name', 'leave_type', 'from_date', 'to_date',
              'description', 'status', 'total_leave_days',
            ]),
            order_by:          'from_date desc',
            limit_page_length: 1000,
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const overtimeReq = firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Overtime Request`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['docstatus',     'in', [0, 1]],
              ['overtime_date', '<=', to],
              ['overtime_date', '>=', from],
            ]),
            fields:            JSON.stringify(['name', 'employee', 'overtime_date', 'start_time', 'end_time', 'status']),
            limit_page_length: 1000,
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const [absenRes, leaveRes, overtimeRes] = await Promise.all([
        absensiReq.catch(() => ({ data: { data: [] } })),
        leaveReq.catch(  () => ({ data: { data: [] } })),
        overtimeReq.catch(() => ({ data: { data: [] } })),
      ]);

      const dataAbsensi = absenRes.data?.data  || [];
      const dataCuti    = leaveRes.data?.data   || [];
      const dataLembur  = overtimeRes.data?.data || [];

      let leaveWithFiles = dataCuti;
      if (dataCuti.length > 0) {
        const docNames = dataCuti.map((l: any) => l.name);
        try {
          const fileRes = await firstValueFrom(
            this.httpService.get(`${erpUrl}/api/resource/File`, {
              headers: { Authorization: authHeader },
              params: {
                filters: JSON.stringify([
                  ['attached_to_doctype', '=',  'Leave Application'],
                  ['attached_to_name',    'in', docNames],
                ]),
                fields:            JSON.stringify(['name', 'file_url', 'attached_to_name']),
                limit_page_length: 1000,
              },
            }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
          );
          const fileData = fileRes.data?.data || [];
          const attachmentMap: Record<string, string> = {};
          fileData.forEach((f: any) => {
            if (!attachmentMap[f.attached_to_name]) attachmentMap[f.attached_to_name] = f.file_url;
          });
          leaveWithFiles = dataCuti.map((l: any) => ({
            ...l,
            attachment: attachmentMap[l.name] || null,
          }));
        } catch (e) {
          console.warn('Gagal menarik file cuti');
        }
      }

      const responseData = { absensi: dataAbsensi, cuti: leaveWithFiles, lembur: dataLembur };
      this.cachedAllHistory.set(cacheKey, { data: responseData, time: now });
      if (this.cachedAllHistory.size > 20) {
        const oldestKey = this.cachedAllHistory.keys().next().value;
        if (oldestKey) this.cachedAllHistory.delete(oldestKey);
      }

      return { success: true, data: responseData };
    } catch (error: any) {
      console.error('getAllHistory Error:', error.response?.data || error.message);
      throw new HttpException('Gagal mengambil riwayat dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET SHIFTS
  // ─────────────────────────────────────────────────────────────────
  async getShifts() {
    const now = Date.now();
    if (this.cachedShifts && (now - this.cachedShifts.time < this.SHIFT_CACHE_TTL)) {
      return { success: true, data: this.cachedShifts.data };
    }

    const { erpUrl, authHeader } = this.getAuth();

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Type`, {
          headers: { Authorization: authHeader },
          params: {
            fields:            JSON.stringify(['name', 'start_time', 'end_time', 'color']),
            order_by:          'name asc',
            limit_page_length: 200,
            _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );
      this.cachedShifts = { data: response.data.data, time: now };
      return { success: true, data: response.data.data };
    } catch {
      throw new HttpException('Gagal mengambil daftar Shift dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET SHIFT LOCATIONS
  //
  // REVISI: Sebelumnya salah doctype — mencari ke `Location` via field
  // `location` di Shift Type, padahal HRD menyimpan data lokasi di
  // doctype `Shift Location` dengan field name yang sama persis dengan
  // nama Shift Type (field: name, latitude, longitude, checkin_radius).
  //
  // Strategi baru (2-step, konsisten dengan locations.controller.ts):
  //   Step 1 — Cari di Shift Location dengan filter name = shiftName.
  //             Ini adalah cara utama: nama Shift Location = nama Shift Type.
  //   Step 2 — Fallback: ambil semua Shift Location, cari yang namanya
  //             mengandung kata kunci dari shift name (partial match).
  //             Berguna jika penamaan tidak 100% identik.
  //
  // Response: { success: true, locations: [{ nama, lat, lng, radius }] }
  // Selalu return success:true + locations:[] jika tidak ditemukan
  // agar frontend bisa handle gracefully.
  // ─────────────────────────────────────────────────────────────────
  async getShiftLocations(shiftName: string) {
    const now    = Date.now();
    const cached = this.cachedShiftLocations.get(shiftName);
    if (cached && (now - cached.time < this.SHIFT_CACHE_TTL)) {
      return { success: true, locations: cached.data };
    }

    const { erpUrl, authHeader } = this.getAuth();

    const mapShiftLocation = (loc: any): { nama: string; lat: number; lng: number; radius: number } | null => {
      const lat    = Number(loc.latitude);
      const lng    = Number(loc.longitude);
      const radius = Number(loc.checkin_radius) || 100;
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) return null;
      return { nama: loc.name, lat, lng, radius };
    };

    try {
      // ── Step 1: cari Shift Location dengan nama = shiftName (exact) ──
      const exactRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Location`, {
          headers: { Authorization: authHeader },
          params: {
            filters:           JSON.stringify([['name', '=', shiftName]]),
            fields:            JSON.stringify(['name', 'latitude', 'longitude', 'checkin_radius']),
            limit_page_length: 1,
            _t:                Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const exactList: any[] = exactRes.data?.data ?? [];
      if (exactList.length > 0) {
        const mapped = mapShiftLocation(exactList[0]);
        if (mapped) {
          this.cachedShiftLocations.set(shiftName, { data: [mapped], time: now });
          return { success: true, locations: [mapped] };
        }
      }

      // ── Step 2: Fallback — ambil semua, cari partial match ────────
      // Berguna jika nama Shift Location ≠ nama Shift Type secara persis,
      // misalnya: shift "Shift Pagi A" → Shift Location "Pagi A" atau sebaliknya.
      const allRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Location`, {
          headers: { Authorization: authHeader },
          params: {
            fields:            JSON.stringify(['name', 'latitude', 'longitude', 'checkin_radius']),
            limit_page_length: 100,
            _t:                Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const allList: any[] = allRes.data?.data ?? [];
      const shiftLower = shiftName.toLowerCase();

      // Cari yang namanya paling cocok: prioritaskan yang namanya
      // mengandung bagian dari shift name, atau sebaliknya.
      const partialMatch = allList.find((loc: any) => {
        const locLower = (loc.name as string).toLowerCase();
        return locLower.includes(shiftLower) || shiftLower.includes(locLower);
      });

      if (partialMatch) {
        const mapped = mapShiftLocation(partialMatch);
        if (mapped) {
          this.cachedShiftLocations.set(shiftName, { data: [mapped], time: now });
          return { success: true, locations: [mapped] };
        }
      }

      // Tidak ditemukan di Shift Location sama sekali
      console.warn(`[ShiftLocations] Tidak ada Shift Location untuk shift: "${shiftName}"`);
      this.cachedShiftLocations.set(shiftName, { data: [], time: now });
      return { success: true, locations: [] };

    } catch (error: any) {
      console.error('[getShiftLocations] Error:', error.response?.data || error.message);
      return { success: true, locations: [] };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // INVALIDATE SHIFT CACHE
  // ─────────────────────────────────────────────────────────────────
  invalidateShiftCache() {
    this.cachedShifts = null;
  }

  // ─────────────────────────────────────────────────────────────────
  // GET LEAVE TYPES
  // ─────────────────────────────────────────────────────────────────
  async getLeaveTypes() {
    const now = Date.now();
    if (this.cachedLeaveTypes && (now - this.cachedLeaveTypes.time < this.CACHE_TTL)) {
      return { success: true, data: this.cachedLeaveTypes.data };
    }

    const { erpUrl, authHeader } = this.getAuth();

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Type`, {
          headers: { Authorization: authHeader },
          params: {
            fields:            JSON.stringify(['name']),
            limit_page_length: 50,
            _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );
      this.cachedLeaveTypes = { data: response.data.data, time: now };
      return { success: true, data: response.data.data };
    } catch {
      throw new HttpException('Gagal mengambil daftar Tipe Izin dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // PROXY FILE
  // ─────────────────────────────────────────────────────────────────
  async proxyFile(filePath: string): Promise<{ buffer: Buffer; contentType: string }> {
    const { erpUrl, authHeader } = this.getAuth();

    const url      = `${erpUrl}${filePath}`;
    const response = await firstValueFrom(
      this.httpService.get(url, {
        headers:      { Authorization: authHeader },
        responseType: 'arraybuffer',
      }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
    );

    const contentType = response.headers['content-type'] || 'image/jpeg';
    return { buffer: Buffer.from(response.data), contentType };
  }

  // ─────────────────────────────────────────────────────────────────
  // GET LEAVE HISTORY
  // ─────────────────────────────────────────────────────────────────
  async getLeaveHistory(employeeId: string) {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const leaveRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['employee',  '=',  employeeId],
              ['docstatus', 'in', [0, 1]],
            ]),
            fields: JSON.stringify([
              'name', 'leave_type', 'from_date', 'to_date',
              'description', 'status', 'total_leave_days',
            ]),
            order_by:          'from_date desc',
            limit_page_length: 50,
            _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const leaveList: any[] = leaveRes.data.data;
      if (!leaveList || leaveList.length === 0) return { success: true, data: [] };

      const docNames = leaveList.map((l) => l.name);

      const fileRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/File`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['attached_to_doctype', '=',  'Leave Application'],
              ['attached_to_name',    'in', docNames],
            ]),
            fields:            JSON.stringify(['name', 'file_url', 'attached_to_name']),
            limit_page_length: 200,
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const attachmentMap: Record<string, string> = {};
      for (const file of fileRes.data.data ?? []) {
        if (!attachmentMap[file.attached_to_name]) {
          attachmentMap[file.attached_to_name] = file.file_url;
        }
      }

      const result = leaveList.map((leave) => ({
        ...leave,
        attachment: attachmentMap[leave.name] ?? null,
      }));

      return { success: true, data: result };
    } catch {
      throw new HttpException('Gagal mengambil riwayat izin dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET ALL LEAVE REQUESTS
  // ─────────────────────────────────────────────────────────────────
  async getAllLeaveRequests() {
    const now = Date.now();
    if (this.cachedAllLeaves && (now - this.cachedAllLeaves.time < this.LEAVE_CACHE_TTL)) {
      return { success: true, data: this.cachedAllLeaves.data };
    }

    const { erpUrl, authHeader } = this.getAuth();
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['docstatus', 'in', [0, 1]],
            ]),
            fields: JSON.stringify([
              'name', 'employee', 'employee_name', 'leave_type', 'from_date', 'to_date',
              'description', 'status', 'total_leave_days',
            ]),
            order_by:          'creation desc',
            limit_page_length: 500,
            _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const leaveList: any[] = res.data.data ?? [];
      if (leaveList.length === 0) return { success: true, data: [] };

      const docNames = leaveList.map((l) => l.name);
      const fileRes  = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/File`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['attached_to_doctype', '=',  'Leave Application'],
              ['attached_to_name',    'in', docNames],
            ]),
            fields:            JSON.stringify(['name', 'file_url', 'attached_to_name']),
            limit_page_length: 500,
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const attachmentMap: Record<string, string> = {};
      for (const file of fileRes.data.data ?? []) {
        if (!attachmentMap[file.attached_to_name]) {
          attachmentMap[file.attached_to_name] = file.file_url;
        }
      }

      const result = leaveList.map((leave) => ({
        ...leave,
        attachment: attachmentMap[leave.name] ?? null,
      }));

      this.cachedAllLeaves = { data: result, time: Date.now() };
      return { success: true, data: result };
    } catch (error: any) {
      console.error('[getAllLeaveRequests] Error:', error.response?.data || error.message);
      return { success: false, data: [], message: 'Gagal mengambil semua data izin' };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Invalidate cache izin
  // ─────────────────────────────────────────────────────────────────
  private invalidateLeaveCache() {
    this.cachedAllLeaves = null;
    this.cachedAllHistory.clear();
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Parse error ERPNext
  // ─────────────────────────────────────────────────────────────────
  private parseErpError(error: any, fallback: string): string {
    const data = error.response?.data;
    if (!data) return fallback;

    if (data.exception) {
      if (data.exception.includes('OverlapError') || data.exception.includes('already applied')) {
        return 'Kamu sudah pernah mengajukan izin/cuti untuk rentang tanggal ini. Silakan cek riwayat pengajuanmu.';
      }
      if (data.exception.includes('InsufficientLeaveBalance')) {
        return 'Jatah cutimu tidak mencukupi untuk pengajuan ini.';
      }
    }

    if (data._server_messages) {
      try {
        const messages = JSON.parse(data._server_messages);
        for (const msgStr of messages) {
          const msgObj = JSON.parse(msgStr);
          if (msgObj.message) {
            if (msgObj.message.includes('OverlapError') || msgObj.message.includes('already applied')) {
              return 'Kamu sudah pernah mengajukan izin/cuti untuk rentang tanggal ini. Silakan cek riwayat pengajuanmu.';
            }
            if (msgObj.message.includes('InsufficientLeaveBalance')) {
              return 'Jatah cutimu tidak mencukupi untuk pengajuan ini.';
            }
            if (msgObj.indicator === 'red') {
              return msgObj.message.replace(/<[^>]*>?/gm, '');
            }
          }
        }
      } catch (e) {}
    }

    return data.message || fallback;
  }

  // ─────────────────────────────────────────────────────────────────
  // SUBMIT LEAVE REQUEST
  // ─────────────────────────────────────────────────────────────────
  async submitLeaveRequest(data: any) {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const hrRes = await this.getHrUsers();
      const defaultApprover = (hrRes.success && hrRes.data.length > 0) ? hrRes.data[0] : 'hrdrotiropi@gmail.com';

      const payload = {
        employee:       data.employee_id,
        leave_type:     data.leave_type,
        from_date:      data.from_date,
        to_date:        data.to_date,
        description:    data.reason,
        leave_approver: defaultApprover,
        status:         'Open',
        docstatus:      0,
      };

      const response = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Leave Application`,
          payload,
          {
            headers: {
              Authorization:  authHeader,
              'Content-Type': 'application/json',
              Accept:         'application/json',
            },
          },
        ).pipe(
          retry({
            count: 3,
            delay: (error, retryCount) => {
              if (error.response && error.response.status >= 400 && error.response.status < 500) return throwError(() => error);
              return timer(retryCount * 1500);
            }
          })
        )
      );

      const docName = response.data.data.name;

      if (docName && data.attachment) {
        try {
          const matches = data.attachment.match(
            /^data:([A-Za-z0-9+\/]+\/[A-Za-z0-9+\/]+);base64,(.+)$/,
          );
          if (!matches) throw new Error('Format base64 tidak valid dari frontend');

          const mimeType   = matches[1];
          const fileBuffer = Buffer.from(matches[2], 'base64');
          const extMap: Record<string, string> = {
            'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
            'image/gif':  'gif', 'image/webp': 'webp', 'application/pdf': 'pdf',
          };
          const ext          = extMap[mimeType] ?? 'jpg';
          const safeFileName = `Bukti_${docName.replace(/-/g, '_')}.${ext}`;
          const boundary     = `----FormBoundary${Date.now()}`;

          const beforeFile = [
            `--${boundary}`,
            `Content-Disposition: form-data; name="file"; filename="${safeFileName}"`,
            `Content-Type: ${mimeType}`,
            '', '',
          ].join('\r\n');

          const afterFile = [
            '',
            `--${boundary}`,
            `Content-Disposition: form-data; name="is_private"`,
            '', '0',
            `--${boundary}`,
            `Content-Disposition: form-data; name="doctype"`,
            '', 'Leave Application',
            `--${boundary}`,
            `Content-Disposition: form-data; name="docname"`,
            '', docName,
            `--${boundary}--`, '',
          ].join('\r\n');

          const bodyBuffer = Buffer.concat([
            Buffer.from(beforeFile, 'utf-8'),
            fileBuffer,
            Buffer.from(afterFile, 'utf-8'),
          ]);

          await firstValueFrom(
            this.httpService.post(`${erpUrl}/api/method/upload_file`, bodyBuffer, {
              headers: {
                Authorization:    authHeader,
                'Content-Type':   `multipart/form-data; boundary=${boundary}`,
                'Content-Length': bodyBuffer.length.toString(),
              },
            }).pipe(retry({ count: 3, delay: (_, retryCount) => timer(retryCount * 1500) }))
          );
        } catch (fileErr: any) {
          console.error('[Upload Gagal] Izin tersimpan, lampiran gagal:', fileErr.message);
        }
      }

      this.invalidateLeaveCache();
      return {
        success: true,
        message: 'Pengajuan cuti/izin berhasil dikirim.',
        data:    response.data.data,
      };
    } catch (error: any) {
      console.error('[submitLeaveRequest] Error:', JSON.stringify(error.response?.data || error.message));

      const errMsg = this.parseErpError(
        error,
        'Gagal menyimpan pengajuan cuti/izin. Silakan cek riwayat atau hubungi HRD.',
      );

      throw new HttpException({ success: false, message: errMsg }, HttpStatus.BAD_REQUEST);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET HR USERS
  // ─────────────────────────────────────────────────────────────────
  async getHrUsers() {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/User`, {
          headers: { Authorization: authHeader },
          params: {
            filters:           JSON.stringify([['role_profile_name', 'like', '%HR%']]),
            fields:            JSON.stringify(['name', 'email', 'full_name']),
            limit_page_length: 20,
            _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );
      const emails: string[] = (response.data.data ?? []).map((u: any) => u.email || u.name);
      return { success: true, data: emails.length > 0 ? emails : ['hrdrotiropi@gmail.com'] };
    } catch {
      return { success: true, data: ['hrdrotiropi@gmail.com'] };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // SUBMIT SHIFT REQUEST
  // ─────────────────────────────────────────────────────────────────
  async submitShiftRequest(data: any) {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const payload = {
        employee:  data.employee_id,
        shift_type: data.shift_type,
        from_date:  data.from_date,
        to_date:    data.to_date,
        approver:   data.approver,
        status:     'Draft',
        docstatus:  0,
      };

      const response = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Shift Request`,
          payload,
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ).pipe(retry({ count: 3, delay: (_, retryCount) => timer(retryCount * 1500) }))
      );

      return { success: true, message: 'Shift Request berhasil diajukan ke HRD.', data: response.data.data };
    } catch (error: any) {
      throw new HttpException('Gagal mengajukan Shift Request.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET SHIFT REQUEST HISTORY
  // ─────────────────────────────────────────────────────────────────
  async getShiftHistory(employeeId: string) {
    const { erpUrl, authHeader } = this.getAuth();
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Request`, {
          headers: { Authorization: authHeader },
          params: {
            filters:           JSON.stringify([['employee', '=', employeeId]]),
            fields:            JSON.stringify([
              'name', 'shift_type', 'from_date', 'to_date',
              'status', 'docstatus', 'creation',
            ]),
            order_by:          'creation desc',
            limit_page_length: 20,
            _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );
      return { success: true, data: res.data.data ?? [] };
    } catch (error: any) {
      console.error('[getShiftHistory] Error:', error.response?.data || error.message);
      return { success: false, data: [], message: 'Gagal mengambil riwayat shift.' };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // CANCEL LEAVE REQUEST
  // ─────────────────────────────────────────────────────────────────
  async cancelLeaveRequest(docName: string) {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const checkRes = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Leave Application/${encodeURIComponent(docName)}`,
          { headers: { Authorization: authHeader } },
        ).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );
      const doc = checkRes.data.data;

      if (doc.docstatus !== 0) {
        throw new HttpException(
          'Izin sudah diproses HRD dan tidak bisa dibatalkan.',
          HttpStatus.BAD_REQUEST,
        );
      }

      await firstValueFrom(
        this.httpService.delete(
          `${erpUrl}/api/resource/Leave Application/${encodeURIComponent(docName)}`,
          { headers: { Authorization: authHeader } },
        ).pipe(retry({ count: 3, delay: (_, retryCount) => timer(retryCount * 1500) }))
      );

      this.invalidateLeaveCache();
      return { success: true, message: 'Pengajuan izin berhasil dibatalkan.' };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      const errMsg = JSON.stringify(error.response?.data || error.message || '');
      if (errMsg.includes('LinkExistsError') || errMsg.includes('Cannot delete')) {
        throw new HttpException(
          'Izin tidak bisa dibatalkan karena sudah terkait data lain.',
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new HttpException('Gagal membatalkan izin.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // FUNGSI UPDATE STATUS IZIN
  // ─────────────────────────────────────────────────────────────────
  async updateLeaveStatus(docName: string, status: 'Approved' | 'Rejected') {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const getRes = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Leave Application/${encodeURIComponent(docName)}`,
          { headers: { Authorization: authHeader } },
        ).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );
      const doc = getRes.data.data;

      if (doc.docstatus !== 0) {
        return { success: false, message: 'Izin ini sudah pernah diproses sebelumnya.' };
      }

      let approver = doc.leave_approver;
      if (!approver) {
        const hrRes = await this.getHrUsers();
        approver = hrRes.success && hrRes.data.length > 0 ? hrRes.data[0] : 'Administrator';
      }

      await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/method/frappe.client.set_value`,
          {
            doctype:   'Leave Application',
            name:      docName,
            fieldname: 'status',
            value:     status,
          },
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ).pipe(retry({ count: 3, delay: (_, retryCount) => timer(retryCount * 1500) }))
      );

      if (!doc.leave_approver) {
        await firstValueFrom(
          this.httpService.post(
            `${erpUrl}/api/method/frappe.client.set_value`,
            {
              doctype:   'Leave Application',
              name:      docName,
              fieldname: 'leave_approver',
              value:     approver,
            },
            { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
          ).pipe(retry({ count: 3, delay: (_, retryCount) => timer(retryCount * 1500) }))
        ).catch(() => {});
      }

      const refreshRes = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Leave Application/${encodeURIComponent(docName)}`,
          { headers: { Authorization: authHeader } },
        ).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );
      const freshDoc = refreshRes.data.data;

      await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/method/frappe.client.submit`,
          { doc: freshDoc },
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ).pipe(retry({ count: 3, delay: (_, retryCount) => timer(retryCount * 1500) }))
      );

      this.invalidateLeaveCache();
      return {
        success: true,
        message: `Izin berhasil ${status === 'Approved' ? 'disetujui' : 'ditolak'}.`,
      };
    } catch (error: any) {
      console.error('[updateLeaveStatus] Error:', JSON.stringify(error.response?.data || error.message));
      const errMsg = this.parseErpError(
        error,
        `Gagal ${status === 'Approved' ? 'menyetujui' : 'menolak'} izin.`,
      );
      throw new HttpException({ success: false, message: errMsg }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // SUBMIT OVERTIME REQUEST (INDIVIDU ATAU KELOMPOK)
  // ─────────────────────────────────────────────────────────────────
  async submitOvertimeRequest(data: any) {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const employees = Array.isArray(data.employee_id) ? data.employee_id : [data.employee_id];

      const results = await Promise.all(
        employees.map(async (empId) => {
          const payload = {
            employee:      empId,
            overtime_date: data.overtime_date,
            start_time:    data.start_time,
            end_time:      data.end_time,
            description:   data.description,
            status:        'Pending',
            docstatus:     0,
          };

          const response = await firstValueFrom(
            this.httpService.post(
              `${erpUrl}/api/resource/Overtime Request`,
              payload,
              { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
            ).pipe(
              retry({ count: 3, delay: (_, retryCount) => timer(retryCount * 1500) })
            )
          );
          return response.data.data;
        })
      );

      return {
        success: true,
        message: `Lembur berhasil diajukan untuk ${employees.length} karyawan.`,
        data:    results,
      };
    } catch (error: any) {
      console.error('[Overtime] Gagal:', error.response?.data || error.message);
      throw new HttpException('Gagal mengajukan lembur. Pastikan data terisi dengan benar.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET OVERTIME HISTORY
  // ─────────────────────────────────────────────────────────────────
  async getOvertimeHistory(employeeId: string) {
    const { erpUrl, authHeader } = this.getAuth();
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Overtime Request`, {
          headers: { Authorization: authHeader },
          params: {
            filters:           JSON.stringify([['employee', '=', employeeId]]),
            fields:            JSON.stringify([
              'name', 'overtime_date', 'start_time', 'end_time',
              'description', 'status', 'creation',
            ]),
            order_by:          'creation desc',
            limit_page_length: 20,
            _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );
      return { success: true, data: res.data.data ?? [] };
    } catch (error: any) {
      return { success: false, data: [], message: 'Gagal mengambil riwayat lembur.' };
    }
  }
}