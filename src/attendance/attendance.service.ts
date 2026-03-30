import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class AttendanceService {
  // ── VARIABEL CACHING ──
  private cachedShifts: { data: any; time: number } | null = null;
  private cachedLeaveTypes: { data: any; time: number } | null = null;
  private cachedAllLeaves: { data: any; time: number } | null = null;
  // Cache getAllHistory: key = "from|to"
  private cachedAllHistory: Map<string, { data: any; time: number }> = new Map();
  private readonly CACHE_TTL = 60 * 60 * 1000;       // 1 jam untuk data statis
  private readonly HISTORY_CACHE_TTL = 2 * 60 * 1000; // 2 menit untuk data absensi
  private readonly LEAVE_CACHE_TTL = 3 * 60 * 1000;   // 3 menit untuk data izin

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

    const hariPart   = isFriday ? 'Jumat' : 'Senin - Kamis';
    const branchPart = isJakarta ? 'Jakarta' : 'PH Klaten';
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
              ['employee',    '=',  employeeId],
              ['shift_type',  '=',  shiftType],
              ['start_date',  '<=', dateStr],
              ['docstatus',   'in', [0, 1]],
            ]),
            fields:            JSON.stringify(['name', 'start_date', 'end_date', 'docstatus']),
            limit_page_length: 50,
            _t: Date.now(), // <-- BUST CACHE VERCEL
          },
        }),
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
        ),
      );

      const docName: string = createRes.data.data.name;

      await firstValueFrom(
        this.httpService.put(
          `${erpUrl}/api/resource/Shift Assignment/${encodeURIComponent(docName)}`,
          { docstatus: 1 },
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ),
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
        ),
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
  // ─────────────────────────────────────────────────────────────────
  async getActiveShift(employeeId: string) {
    const { erpUrl, authHeader } = this.getAuth();
    const todayStr = this.getTodayWib();

    try {
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
            _t: Date.now(), // <-- BUST CACHE VERCEL
          },
        }),
      );

      const assignments: any[] = assignRes.data.data ?? [];
      const aktifAssignment = assignments.find((a) => {
        if (!a.end_date) return true; 
        return a.end_date >= todayStr;
      });

      if (aktifAssignment) {
        const detail = await this.getShiftTypeDetail(erpUrl, authHeader, aktifAssignment.shift_type);
        if (detail) return { success: true, source: 'assignment', ...detail };
      }

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
            _t: Date.now(), // <-- BUST CACHE VERCEL
          },
        }),
      );

      const requests: any[] = reqRes.data.data ?? [];
      const aktifRequest = requests.find((r) => {
        if (!r.to_date) return true; 
        return r.to_date >= todayStr;
      });

      if (aktifRequest) {
        const detail = await this.getShiftTypeDetail(erpUrl, authHeader, aktifRequest.shift_type);
        if (detail) return { success: true, source: 'request', ...detail };
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

      const mimeType = matches[1];
      const fileBuffer = Buffer.from(matches[2], 'base64');
      const extMap: Record<string, string> = {
        'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
        'image/gif': 'gif', 'image/webp': 'webp',
      };
      const ext = extMap[mimeType] ?? 'jpg';
      const safeFileName = `${fileNamePrefix}_${Date.now()}.${ext}`;
      const boundary = `----FormBoundary${Date.now()}`;

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
            Authorization: authHeader,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': bodyBuffer.length.toString(),
          },
        }),
      );

      return res.data.message.file_url;
    } catch (err: any) {
      console.error(`[Upload File Gagal untuk ${fileNamePrefix}]:`, err.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // CREATE CHECKIN
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

      const fotoAbsenUrl = await this.uploadBase64ToERPNext(erpUrl, authHeader, data.image_verification, `Absen_${data.employee_id}_Depan`);
      const fotoKiriUrl  = await this.uploadBase64ToERPNext(erpUrl, authHeader, data.custom_verification_image, `Absen_${data.employee_id}_Kiri`);
      const ttdUrl       = await this.uploadBase64ToERPNext(erpUrl, authHeader, data.custom_signature, `Absen_${data.employee_id}_TTD`);

      const payload: any = {
        employee:                  data.employee_id,
        log_type:                  logType,
        time:                      timeString,
        latitude:                  data.latitude,
        longitude:                 data.longitude,
        custom_foto_absen:         fotoAbsenUrl || data.image_verification, 
        custom_verification_image: fotoKiriUrl || data.custom_verification_image,
        custom_signature:          ttdUrl || data.custom_signature,
        shift:                     shiftName,
        device_id:                 'RopiHR-PWA',
      };

      const response = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Employee Checkin`,
          payload,
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ),
      );

      return {
        success:               true,
        message:               `Absen ${logType === 'IN' ? 'MASUK' : 'KELUAR'} berhasil!`,
        data:                  response.data.data,
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
  // GET HISTORY (Dioptimasi dengan _t agar langsung refresh)
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
              'custom_foto_absen', 'custom_signature', 'shift',
              'custom_verification_image', 'latitude', 'longitude',
            ]),
            order_by:          'time desc',
            limit_page_length: 100,
            _t: Date.now(), // <-- BUST CACHE VERCEL
          },
        }),
      );
      return { success: true, data: response.data.data };
    } catch {
      throw new HttpException('Gagal mengambil riwayat absen dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET ALL HISTORY (HR Dashboard) - OPTIMASI BULK FETCHING + CACHING
  // ─────────────────────────────────────────────────────────────────
  async getAllHistory(from: string, to: string) {
    const cacheKey = `${from}|${to}`;
    const now = Date.now();
    const cached = this.cachedAllHistory.get(cacheKey);
    if (cached && (now - cached.time < this.HISTORY_CACHE_TTL)) {
      return { success: true, data: cached.data };
    }

    const { erpUrl, authHeader } = this.getAuth();

    try {
      // 1. Tarik Semua Data Absen
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
              'custom_foto_absen', 'custom_signature', 'shift',
              'latitude', 'longitude',
            ]),
            order_by: 'time desc',
            limit_page_length: 1000,
          },
        })
      );

      // 2. Tarik Semua Data Cuti/Izin yang beririsan dengan periode ini
      const leaveReq = firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['docstatus', 'in', [0, 1]],
              ['from_date', '<=', to],
              ['to_date', '>=', from],
            ]),
            fields: JSON.stringify([
              'name', 'employee', 'employee_name', 'leave_type', 'from_date', 'to_date',
              'description', 'status', 'total_leave_days'
            ]),
            order_by: 'from_date desc',
            limit_page_length: 500,
          },
        })
      );

      // Eksekusi kedua request secara paralel ke ERPNext
      const [absenRes, leaveRes] = await Promise.all([
        absensiReq.catch(() => ({ data: { data: [] } })),
        leaveReq.catch(() => ({ data: { data: [] } }))
      ]);

      const dataAbsensi = absenRes.data?.data || [];
      const dataCuti = leaveRes.data?.data || [];

      // 3. Gabungkan file attachment untuk Cuti/Izin jika ada
      let leaveWithFiles = dataCuti;
      if (dataCuti.length > 0) {
        const docNames = dataCuti.map((l: any) => l.name);
        try {
          const fileRes = await firstValueFrom(
            this.httpService.get(`${erpUrl}/api/resource/File`, {
              headers: { Authorization: authHeader },
              params: {
                filters: JSON.stringify([
                  ['attached_to_doctype', '=', 'Leave Application'],
                  ['attached_to_name', 'in', docNames],
                ]),
                fields: JSON.stringify(['name', 'file_url', 'attached_to_name']),
                limit_page_length: 500,
              },
            })
          );
          const fileData = fileRes.data?.data || [];
          const attachmentMap: Record<string, string> = {};
          fileData.forEach((f: any) => {
            if (!attachmentMap[f.attached_to_name]) attachmentMap[f.attached_to_name] = f.file_url;
          });
          leaveWithFiles = dataCuti.map((l: any) => ({
            ...l,
            attachment: attachmentMap[l.name] || null
          }));
        } catch (e) {
          console.warn('Gagal menarik file cuti');
        }
      }

      // Simpan ke cache agar request berikutnya tidak re-hit ERPNext
      const responseData = { absensi: dataAbsensi, cuti: leaveWithFiles };
      this.cachedAllHistory.set(cacheKey, { data: responseData, time: now });
      // Bersihkan cache lama jika ada lebih dari 20 key (misal banyak range periode berbeda)
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
    // Jika cache masih ada dan usianya kurang dari 1 jam, gunakan cache
    if (this.cachedShifts && (now - this.cachedShifts.time < this.CACHE_TTL)) {
      return { success: true, data: this.cachedShifts.data };
    }

    const { erpUrl, authHeader } = this.getAuth();

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Type`, {
          headers: { Authorization: authHeader },
          params: {
            fields:            JSON.stringify(['name', 'start_time', 'end_time', 'color']),
            limit_page_length: 100,
            _t: Date.now(), // Memastikan ERPNext memberikan data terbaru saat Cache ditarik ulang
          },
        }),
      );
      // Simpan ke Cache
      this.cachedShifts = { data: response.data.data, time: now };
      return { success: true, data: response.data.data };
    } catch {
      throw new HttpException('Gagal mengambil daftar Shift dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET LEAVE TYPES
  // ─────────────────────────────────────────────────────────────────
  async getLeaveTypes() {
    const now = Date.now();
    // Cek cache
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
            _t: Date.now(), // Memastikan ERPNext memberikan data terbaru saat Cache ditarik ulang
          },
        }),
      );
      // Simpan ke cache
      this.cachedLeaveTypes = { data: response.data.data, time: now };
      return { success: true, data: response.data.data };
    } catch {
      throw new HttpException('Gagal mengambil daftar Tipe Izin dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // PROXY FILE (untuk foto bukti izin)
  // ─────────────────────────────────────────────────────────────────
  async proxyFile(filePath: string): Promise<{ buffer: Buffer; contentType: string }> {
    const { erpUrl, authHeader } = this.getAuth();

    const url      = `${erpUrl}${filePath}`;
    const response = await firstValueFrom(
      this.httpService.get(url, {
        headers:      { Authorization: authHeader },
        responseType: 'arraybuffer',
      }),
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
            filters:           JSON.stringify([
              ['employee', '=', employeeId],
              ['docstatus', 'in', [0, 1]], // ambil Draft (Open) DAN Submitted (Approved/Rejected)
            ]),
            fields:            JSON.stringify([
              'name', 'leave_type', 'from_date', 'to_date',
              'description', 'status', 'total_leave_days',
            ]),
            order_by:          'from_date desc',
            limit_page_length: 50,
            _t: Date.now(), // <-- BUST CACHE VERCEL
          },
        }),
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
        }),
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
  // GET ALL LEAVE REQUESTS (Untuk Kelola Izin HRD) + CACHE
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
              ['docstatus', 'in', [0, 1]], // ambil Draft (Open) DAN Submitted (Approved/Rejected)
            ]),
            fields: JSON.stringify([
              'name', 'employee', 'employee_name', 'leave_type', 'from_date', 'to_date',
              'description', 'status', 'total_leave_days'
            ]),
            order_by: 'creation desc',
            limit_page_length: 500,
            _t: Date.now(), // <-- BUST CACHE VERCEL
          },
        }),
      );
      
      const leaveList: any[] = res.data.data ?? [];
      if (leaveList.length === 0) return { success: true, data: [] };

      const docNames = leaveList.map((l) => l.name);
      const fileRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/File`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['attached_to_doctype', '=',  'Leave Application'],
              ['attached_to_name',    'in', docNames],
            ]),
            fields: JSON.stringify(['name', 'file_url', 'attached_to_name']),
            limit_page_length: 500,
          },
        }),
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
  // HELPER: Invalidate cache izin (dipanggil setelah approve/reject/cancel)
  // ─────────────────────────────────────────────────────────────────
  private invalidateLeaveCache() {
    this.cachedAllLeaves = null;
    this.cachedAllHistory.clear();
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Parse pesan error dari ERPNext _server_messages & exception
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
      // Gunakan email HRD Roti Ropi sebagai fallback jika kosong, jangan 'Administrator'
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
        ),
      );

      const docName = response.data.data.name;

      // Logic Upload File Bukti (Jika Ada)
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
                Authorization:   authHeader,
                'Content-Type':  `multipart/form-data; boundary=${boundary}`,
                'Content-Length': bodyBuffer.length.toString(),
              },
            }),
          );
        } catch (fileErr: any) {
          console.error('[Upload Gagal] Izin tersimpan, lampiran gagal:', fileErr.message);
        }
      }

      return {
        success: true,
        message: 'Pengajuan cuti/izin berhasil dikirim.',
        data:    response.data.data,
      };
    } catch (error: any) {
      console.error('[submitLeaveRequest] Error:', JSON.stringify(error.response?.data || error.message));
      
      const errMsg = this.parseErpError(
        error,
        'Gagal menyimpan pengajuan cuti/izin. Silakan cek riwayat atau hubungi HRD.'
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
            filters: JSON.stringify([
              ['role_profile_name', 'like', '%HR%'],
            ]),
            fields:            JSON.stringify(['name', 'email', 'full_name']),
            limit_page_length: 20,
            _t: Date.now(), // <-- BUST CACHE VERCEL
          },
        }),
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
        employee:        data.employee_id,
        shift_type:      data.shift_type,
        from_date:       data.from_date,
        to_date:         data.to_date,
        approver:        data.approver,
        status:          'Draft',
        docstatus:       0,
      };

      const response = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Shift Request`,
          payload,
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ),
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
            filters: JSON.stringify([['employee', '=', employeeId]]),
            fields: JSON.stringify([
              'name', 'shift_type', 'from_date', 'to_date',
              'status', 'docstatus', 'creation',
            ]),
            order_by:          'creation desc',
            limit_page_length: 20,
            _t: Date.now(), // <-- BUST CACHE VERCEL
          },
        }),
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
        ),
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
        ),
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
  // FUNGSI UPDATE STATUS IZIN (APPROVE / REJECT)
  // ─────────────────────────────────────────────────────────────────
  async updateLeaveStatus(docName: string, status: 'Approved' | 'Rejected') {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const getRes = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Leave Application/${encodeURIComponent(docName)}`,
          { headers: { Authorization: authHeader } },
        ),
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
            doctype:  'Leave Application',
            name:     docName,
            fieldname: 'status',
            value:    status,
          },
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ),
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
          ),
        ).catch(() => {});
      }

      const refreshRes = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Leave Application/${encodeURIComponent(docName)}`,
          { headers: { Authorization: authHeader } },
        ),
      );
      const freshDoc = refreshRes.data.data;

      await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/method/frappe.client.submit`,
          { doc: freshDoc },
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ),
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
}