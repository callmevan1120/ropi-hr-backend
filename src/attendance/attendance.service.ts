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
  // Cache branch locations: key = branch_name
  private cachedBranchLocations: Map<string, { data: any; time: number }> = new Map();

  // REVISI: TTL shift diturunkan drastis (5 menit → 2 menit) agar
  // shift type baru yang ditambahkan HRD di ERPNext lebih cepat
  // terdeteksi tanpa harus restart server.
  private readonly SHIFT_CACHE_TTL   = 2 * 60 * 1000;  // 2 menit (sebelumnya 1 jam)
  private readonly CACHE_TTL         = 60 * 60 * 1000;  // 1 jam  (untuk data statis lain)
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
    shiftLocation?: string | null,
  ): Promise<{ created: boolean; docName: string | null; error?: string }> {
    try {
      const alreadyExists = await this.hasExistingShiftAssignment(
        erpUrl, authHeader, employeeId, shiftType, dateStr,
      );

      if (alreadyExists) return { created: false, docName: null };

      // 1. Buat Shift Assignment dasar DULU (Tanpa Lokasi) agar pasti berhasil
      const createPayload: any = {
        employee:   employeeId,
        shift_type: shiftType,
        start_date: dateStr,
        end_date:   dateStr,
        docstatus:  0,
        shift_location: shiftLocation,
      };

      const createRes = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Shift Assignment`,
          createPayload,
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ).pipe(retry({ count: 2, delay: (error, retryCount) => timer(retryCount * 1000) }))
      );

      const docName: string = createRes.data.data.name;

      // 2. 🔥 SUNTIK PAKSA LOKASI KE DATABASE MENGGUNAKAN set_value
      if (shiftLocation) {
        try {
          await firstValueFrom(
            this.httpService.post(
              `${erpUrl}/api/method/frappe.client.set_value`,
              {
                doctype:   'Shift Assignment',
                name:      docName,
                fieldname: 'shift_location', // Coba tembak nama bawaan
                value:     shiftLocation,
              },
              { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } }
            )
          );
        } catch (e) {
          // Kalau gagal, berarti namanya custom_shift_location. Tembak lagi!
          try {
             await firstValueFrom(
              this.httpService.post(
                `${erpUrl}/api/method/frappe.client.set_value`,
                {
                  doctype:   'Shift Assignment',
                  name:      docName,
                  fieldname: 'custom_shift_location', 
                  value:     shiftLocation,
                },
                { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } }
              )
            );
          } catch (err) {
            console.warn('[ShiftAssignment] Gagal inject lokasi via set_value');
          }
        }
      }

      // 3. Submit (Ubah docstatus jadi 1)
      await firstValueFrom(
        this.httpService.put(
          `${erpUrl}/api/resource/Shift Assignment/${encodeURIComponent(docName)}`,
          { docstatus: 1 },
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
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
  // GET ACTIVE SHIFT (EFISIEN & ANTI N+1)
  // ─────────────────────────────────────────────────────────────────
  async getActiveShift(employeeId: string) {
    const { erpUrl, authHeader } = this.getAuth();
    const todayStr = this.getTodayWib();

    try {
      // 1. Cek Shift Assignment (Pakai field bawaan: shift_location)
      const assignRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Assignment`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['employee',   '=',  employeeId],
              ['start_date', '<=', todayStr],
            ]),
            fields: JSON.stringify(['name', 'shift_type', 'shift_location', 'start_date', 'end_date', 'docstatus']),
            order_by: 'start_date desc', limit_page_length: 50, _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const assignments: any[] = assignRes.data.data ?? [];
      const aktifAssignment = assignments.find((a) => {
        if (a.docstatus !== 0 && a.docstatus !== 1) return false;
        if (!a.end_date) return true;
        return a.end_date >= todayStr;
      });

      if (aktifAssignment) {
        const detail = await this.getShiftTypeDetail(erpUrl, authHeader, aktifAssignment.shift_type);
        if (detail) {
          return { success: true, source: 'assignment', shift_location: aktifAssignment.shift_location ?? null, ...detail };
        }
      }

      // 2. Cek Shift Request (Pakai field custom: custom_shift_location)
      const reqRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Request`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['employee',  '=',  employeeId],
              ['from_date', '<=', todayStr],
            ]),
            ields: JSON.stringify(['name', 'shift_type', 'custom_shift_location', 'from_date', 'to_date', 'status', 'docstatus']),
            order_by: 'from_date desc', limit_page_length: 50, _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const requests: any[] = reqRes.data.data ?? [];
      const aktifRequest = requests.find((r) => {
        if (r.status !== 'Approved') return false;
        if (r.docstatus !== 0 && r.docstatus !== 1) return false;
        if (!r.to_date) return true;
        return r.to_date >= todayStr;
      });

      if (aktifRequest) {
        const detail = await this.getShiftTypeDetail(erpUrl, authHeader, aktifRequest.shift_type);
        if (detail) {
          // Map ke shift_location agar React gampang bacanya
          return { success: true, source: 'request', shift_location: aktifRequest.custom_shift_location ?? null, ...detail };
        }
      }

      return { success: false, message: 'Belum ada Shift yang di-Approve HRD hari ini.' };

    } catch (error: any) {
      console.error('[getActiveShift] Error:', error.response?.data || error.message);
      return { success: false, message: 'Gagal membaca Shift dari ERPNext. Coba lagi.' };
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
  // CREATE CHECKIN (GEMBOK KETAT)
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

      const branch         = data.branch ?? '';
      const shiftLocation  = data.shift_location ?? null; 
      const isOutlet       = branch && !this.isOfficeShift(shiftName);

      if (branch) {
        if (isOutlet) {
          // 🔥 KUNCI UTAMA: Jika lokasi penugasan kosong, TOLAK ABSENNYA!
          if (!shiftLocation) {
            throw new HttpException(
              { success: false, message: `Data lokasi penugasan kosong. Jadwal shift-mu cacat. Harap hapus jadwal dan ajukan ulang ke HRD!`, error_code: 'MISSING_LOCATION' },
              HttpStatus.BAD_REQUEST,
            );
          }

          const locationValidation = await this.validateOutletLocation(
            erpUrl, authHeader, data.latitude, data.longitude, shiftLocation,
          );

          if (!locationValidation.valid) {
            throw new HttpException(
              { success: false, message: `Lokasi tidak valid: ${locationValidation.message}`, error_code: 'INVALID_LOCATION' },
              HttpStatus.BAD_REQUEST,
            );
          }
          console.log(`[Checkin Outlet - ${logType}] ${data.employee_id} di ${locationValidation.nearestLocation} (${locationValidation.distance}m)`);
        } else if (!isOutlet) {
          const locationValidation = await this.validateCheckinLocation(
            erpUrl, authHeader, data.employee_id, data.latitude, data.longitude, branch,
          );

          if (!locationValidation.valid) {
            throw new HttpException(
              { success: false, message: `Lokasi tidak valid: ${locationValidation.message}`, error_code: 'INVALID_LOCATION' },
              HttpStatus.BAD_REQUEST,
            );
          }
          console.log(`[Checkin Kantor - ${logType}] ${data.employee_id} di ${locationValidation.nearestLocation} (${locationValidation.distance}m)`);
        }
      }

      let shiftAssignmentInfo: { created: boolean; docName: string | null; error?: string } =
        { created: false, docName: null };

      if (logType === 'IN' && shiftName) {
        shiftAssignmentInfo = await this.ensureShiftAssignment(
          erpUrl, authHeader, data.employee_id, shiftName, todayStr, 
          shiftLocation // 👈 Bawa lokasi ini ke Shift Assignment
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
              if (error.response && error.response.status >= 400 && error.response.status < 500) return throwError(() => error);
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
      throw new HttpException('Gagal menyimpan absen ke sistem HR.', HttpStatus.INTERNAL_SERVER_ERROR);
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
              'custom_foto_absen', 'custom_verification_image', 'shift',
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
  // REVISI: Gunakan SHIFT_CACHE_TTL (2 menit) bukan CACHE_TTL (1 jam).
  // Tambah query param `order_by` dan `limit_page_length` eksplisit
  // agar semua shift type terbaru di ERPNext selalu ikut terambil.
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
            // REVISI: Gunakan limit_page_length DAN limit (beberapa versi ERPNext butuh keduanya)
            limit_page_length: 100,
            limit:             100,
            _t: Date.now(), // cache-busting agar ERPNext tidak serve stale response
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
  // Menarik field `location` dari Shift Type ERPNext, lalu resolve
  // koordinat dari doctype `Location` (Shift Location).
  // Response: { success, locations: [{ nama, lat, lng, radius }] }
  //
  // ERPNext menyimpan lokasi shift di Shift Type → field `location`
  // (linked ke doctype Location). Setiap Location punya:
  //   - location_name  (nama tampil)
  //   - latitude / longitude
  //   - geofencing_radius (opsional, default 100m)
  // ─────────────────────────────────────────────────────────────────
  async getShiftLocations(shiftName: string) {
    const now = Date.now();
    const cached = this.cachedShiftLocations.get(shiftName);
    if (cached && (now - cached.time < this.SHIFT_CACHE_TTL)) {
      return { success: true, locations: cached.data };
    }

    const { erpUrl, authHeader } = this.getAuth();

    try {
      // Step 1: Ambil detail Shift Type untuk mendapatkan nama Location
      const shiftRes = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Shift Type/${encodeURIComponent(shiftName)}`,
          { headers: { Authorization: authHeader } },
        ).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const shiftData = shiftRes.data?.data;

      // ERPNext Shift Type menyimpan lokasi di field `location`
      // (bisa berupa string nama Location atau array child table)
      const locationName: string | null =
        shiftData?.location || shiftData?.custom_shift_location || null;

      if (!locationName) {
        // Shift ini tidak punya lokasi yang di-set di ERPNext
        return { success: true, locations: [] };
      }

      // Step 2: Resolve koordinat dari doctype Location
      const locRes = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Location/${encodeURIComponent(locationName)}`,
          { headers: { Authorization: authHeader } },
        ).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const loc = locRes.data?.data;

      // Koordinat bisa tersimpan langsung atau dalam GeoJSON point
      let lat: number | null = null;
      let lng: number | null = null;

      if (loc?.latitude && loc?.longitude) {
        lat = parseFloat(loc.latitude);
        lng = parseFloat(loc.longitude);
      } else if (loc?.location) {
        // GeoJSON format: { type: "Point", coordinates: [lng, lat] }
        try {
          const geo = typeof loc.location === 'string' ? JSON.parse(loc.location) : loc.location;
          if (geo?.type === 'Point' && Array.isArray(geo.coordinates)) {
            lng = geo.coordinates[0];
            lat = geo.coordinates[1];
          } else if (geo?.features?.[0]?.geometry?.coordinates) {
            // FeatureCollection format
            const coords = geo.features[0].geometry.coordinates;
            lng = coords[0];
            lat = coords[1];
          }
        } catch { /* tidak bisa parse GeoJSON */ }
      }

      if (lat === null || lng === null || isNaN(lat) || isNaN(lng)) {
        console.warn(`[ShiftLocations] Koordinat tidak ditemukan untuk Location: ${locationName}`);
        return { success: true, locations: [] };
      }

      const radius = parseFloat(loc?.geofencing_radius || loc?.radius || '100') || 100;

      const result = [{
        nama:   loc.location_name || locationName,
        lat,
        lng,
        radius,
      }];

      this.cachedShiftLocations.set(shiftName, { data: result, time: now });
      return { success: true, locations: result };

    } catch (error: any) {
      console.error('[getShiftLocations] Error:', error.response?.data || error.message);
      // Kembalikan array kosong (bukan error) agar frontend bisa fallback
      return { success: true, locations: [] };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // INVALIDATE SHIFT CACHE (bisa dipanggil dari controller jika perlu)
  // REVISI: Ditambahkan endpoint baru untuk force-refresh shift list
  // dari luar (misal oleh HRD setelah menambah shift type baru).
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
  // HELPER: Hitung jarak Haversine (meter) antara 2 koordinat
  // ─────────────────────────────────────────────────────────────────
  private haversineDistance(
    lat1: number, lon1: number,
    lat2: number, lon2: number,
  ): number {
    const R = 6371000; // Radius bumi dalam meter
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Ambil lokasi branch dari ERPNext (Shift Location)
  // ─────────────────────────────────────────────────────────────────
  private async getBranchLocations(
    erpUrl: string,
    authHeader: string,
    branchName: string,
  ): Promise<Array<{ nama: string; lat: number; lng: number; radius: number }>> {
    const now = Date.now();
    const cached = this.cachedBranchLocations.get(branchName);
    if (cached && (now - cached.time < this.SHIFT_CACHE_TTL)) {
      return cached.data;
    }

    try {
      // Ambil dari doctype Shift Location di ERPNext
      const res = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Location`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['name', 'like', `%${branchName}%`],
            ]),
            fields: JSON.stringify(['name', 'latitude', 'longitude', 'checkin_radius']),
            limit_page_length: 20,
            _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );

      const locations: Array<{ nama: string; lat: number; lng: number; radius: number }> = [];
      for (const loc of res.data.data ?? []) {
        const lat = parseFloat(loc.latitude);
        const lng = parseFloat(loc.longitude);
        const radius = parseFloat(loc.checkin_radius) || 100;
        if (!isNaN(lat) && !isNaN(lng)) {
          locations.push({
            nama: loc.name,
            lat,
            lng,
            radius,
          });
        }
      }

      this.cachedBranchLocations.set(branchName, { data: locations, time: now });
      return locations;
    } catch (error: any) {
      console.error(`[getBranchLocations] Error untuk ${branchName}:`, error.response?.data || error.message);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Validasi lokasi checkin terhadap branch karyawan
  // Returns: { valid: boolean; message: string; nearestLocation: string }
  // ─────────────────────────────────────────────────────────────────
  private async validateCheckinLocation(
    erpUrl: string,
    authHeader: string,
    employeeId: string,
    latitude: number,
    longitude: number,
    branch: string,
  ): Promise<{ valid: boolean; message: string; nearestLocation: string; distance: number }> {
    const DEFAULT_RADIUS = 200; // Default radius 200m jika tidak ada setting

    // Jika koordinat tidak valid, tolak
    if (latitude === undefined || latitude === null || longitude === undefined || longitude === null) {
      return { valid: false, message: 'Koordinat GPS tidak valid.', nearestLocation: '', distance: 0 };
    }

    // Jika koordinat 0,0 (fallback saat GPS tidak tersedia), tolak untuk keamanan
    if (latitude === 0 && longitude === 0) {
      return { valid: false, message: 'GPS tidak terdeteksi. Aktifkan lokasi dan coba lagi.', nearestLocation: '', distance: 0 };
    }

    // Ambil lokasi branch dari ERPNext
    const branchLocations = await this.getBranchLocations(erpUrl, authHeader, branch);

    // Jika tidak ada lokasi branch di ERPNext, izinkan dengan warning
    if (branchLocations.length === 0) {
      console.warn(`[validateCheckinLocation] Tidak ada lokasi branch "${branch}" di ERPNext. Checkin diizinkan.`);
      return { valid: true, message: '', nearestLocation: branch, distance: 0 };
    }

    // Cari lokasi branch terdekat
    let nearestLocation = branchLocations[0];
    let minDistance = this.haversineDistance(latitude, longitude, nearestLocation.lat, nearestLocation.lng);

    for (const loc of branchLocations) {
      const dist = this.haversineDistance(latitude, longitude, loc.lat, loc.lng);
      if (dist < minDistance) {
        minDistance = dist;
        nearestLocation = loc;
      }
    }

    const allowedRadius = nearestLocation.radius || DEFAULT_RADIUS;

    if (minDistance <= allowedRadius) {
      return {
        valid: true,
        message: '',
        nearestLocation: nearestLocation.nama,
        distance: Math.round(minDistance),
      };
    }

    return {
      valid: false,
      message: `Anda berada ${Math.round(minDistance)}m dari ${nearestLocation.nama}. Maksimum ${allowedRadius}m dari lokasi branch.`,
      nearestLocation: nearestLocation.nama,
      distance: Math.round(minDistance),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Validasi lokasi checkin khusus OUTLET berdasarkan Shift Location
  // ─────────────────────────────────────────────────────────────────
  private async validateOutletLocation(
    erpUrl: string,
    authHeader: string,
    latitude: number,
    longitude: number,
    shiftLocation: string,
  ): Promise<{ valid: boolean; message: string; nearestLocation: string; distance: number }> {
    if (latitude === undefined || latitude === null || longitude === undefined || longitude === null || (latitude === 0 && longitude === 0)) {
      return { valid: false, message: 'GPS tidak terdeteksi. Aktifkan lokasi dan coba lagi.', nearestLocation: '', distance: 0 };
    }

    // Ambil koordinat dari doctype Shift Location di ERPNext
    const shiftLocs = await this.getBranchLocations(erpUrl, authHeader, shiftLocation);

    // 🔥 REVISI UTAMA: Hapus toleransi (fallback). 
    // Jika HRD belum input koordinat outlet di ERPNext, WAJIB DITOLAK!
    if (!shiftLocs || shiftLocs.length === 0) {
      return { 
        valid: false, 
        message: `Titik koordinat GPS untuk outlet "${shiftLocation}" belum di-setting oleh HRD di sistem. Harap hubungi HRD!`, 
        nearestLocation: shiftLocation, 
        distance: 0 
      };
    }

    const loc = shiftLocs[0];
    const dist = this.haversineDistance(latitude, longitude, loc.lat, loc.lng);

    if (dist <= loc.radius) {
      return { valid: true, message: '', nearestLocation: loc.nama, distance: Math.round(dist) };
    }

    return {
      valid: false,
      message: `Anda berada ${Math.round(dist)}m dari ${loc.nama}. Maksimum radius adalah ${loc.radius}m.`,
      nearestLocation: loc.nama,
      distance: Math.round(dist),
    };
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
      const payload: any = {
        employee:   data.employee_id,
        shift_type: data.shift_type,
        from_date:  data.from_date,
        to_date:    data.to_date,
        approver:   data.approver,
        status:     'Draft',
        docstatus:  0,
      };

      // 🔥 Wajib pakai custom_shift_location karena ini masuk ke Shift Request
      if (data.shift_location) {
         payload.custom_shift_location = data.shift_location;
      }

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
  // GET SHIFT REQUEST HISTORY (EFISIEN & ANTI N+1)
  // ─────────────────────────────────────────────────────────────────
  async getShiftHistory(employeeId: string) {
    const { erpUrl, authHeader } = this.getAuth();
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Request`, {
          headers: { Authorization: authHeader },
          params: {
            filters:           JSON.stringify([['employee', '=', employeeId]]),
            fields:            JSON.stringify(['name', 'shift_type', 'custom_shift_location', 'from_date', 'to_date', 'status', 'docstatus', 'creation']),
            order_by:          'creation desc',
            limit_page_length: 20,
            _t: Date.now(),
          },
        }).pipe(retry({ count: 2, delay: (_, retryCount) => timer(retryCount * 1000) }))
      );
      
      const mappedData = (res.data.data ?? []).map((item: any) => ({
        ...item,
        shift_location: item.custom_shift_location ?? null
      }));

      return { success: true, data: mappedData };
    } catch (error: any) {
      console.error('[getShiftHistory] Error:', error.response?.data || error.message);
      return { success: false, data: [], message: 'Gagal mengambil riwayat shift.' };
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