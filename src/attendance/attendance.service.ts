import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class AttendanceService {
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
              'custom_foto_absen', 'custom_signature', 'shift',
              'custom_verification_image', 'latitude', 'longitude',
            ]),
            order_by:          'time desc',
            limit_page_length: 100,
          },
        }),
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
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const response = await firstValueFrom(
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
            order_by:          'time desc',
            limit_page_length: 500,
          },
        }),
      );
      return { success: true, data: response.data.data };
    } catch {
      throw new HttpException('Gagal mengambil semua riwayat absen.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET SHIFTS
  // ─────────────────────────────────────────────────────────────────
  async getShifts() {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Type`, {
          headers: { Authorization: authHeader },
          params: {
            fields:            JSON.stringify(['name', 'start_time', 'end_time', 'color']),
            limit_page_length: 100,
          },
        }),
      );
      return { success: true, data: response.data.data };
    } catch {
      throw new HttpException('Gagal mengambil daftar Shift dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET LEAVE TYPES
  // ─────────────────────────────────────────────────────────────────
  async getLeaveTypes() {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Type`, {
          headers: { Authorization: authHeader },
          params: {
            fields:            JSON.stringify(['name']),
            limit_page_length: 50,
          },
        }),
      );
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
            filters:           JSON.stringify([['employee', '=', employeeId]]),
            fields:            JSON.stringify([
              'name', 'leave_type', 'from_date', 'to_date',
              'description', 'status', 'total_leave_days',
            ]),
            order_by:          'from_date desc',
            limit_page_length: 50,
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
  // GET ALL LEAVE REQUESTS (Untuk Kelola Izin HRD)
  // ─────────────────────────────────────────────────────────────────
  async getAllLeaveRequests() {
    const { erpUrl, authHeader } = this.getAuth();
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
          headers: { Authorization: authHeader },
          params: {
            fields: JSON.stringify([
              'name', 'employee', 'employee_name', 'leave_type', 'from_date', 'to_date',
              'description', 'status', 'total_leave_days'
            ]),
            order_by: 'creation desc',
            limit_page_length: 500,
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

      return { success: true, data: result };
    } catch (error: any) {
      console.error('[getAllLeaveRequests] Error:', error.response?.data || error.message);
      return { success: false, data: [], message: 'Gagal mengambil semua data izin' };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // SUBMIT LEAVE REQUEST
  // ─────────────────────────────────────────────────────────────────
  async submitLeaveRequest(data: any) {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const hrRes = await this.getHrUsers();
      const defaultApprover = (hrRes.success && hrRes.data.length > 0) ? hrRes.data[0] : 'Administrator';

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
        message: 'Izin berhasil diajukan beserta buktinya',
        data:    response.data.data,
      };
    } catch (error: any) {
      const errorString = JSON.stringify(error.response?.data || {});

      if (errorString.includes('Overlap')) {
        throw new HttpException('Gagal: Sudah ada izin di tanggal tersebut.', HttpStatus.BAD_REQUEST);
      } else if (errorString.includes('allocation')) {
        throw new HttpException('Gagal: Kuota izin tidak mencukupi.', HttpStatus.BAD_REQUEST);
      } else {
        throw new HttpException('Gagal menyimpan pengajuan izin.', HttpStatus.INTERNAL_SERVER_ERROR);
      }
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

  // FUNGSI UPDATE STATUS IZIN (APPROVE / REJECT) - 2 TAHAP
  async updateLeaveStatus(docName: string, status: 'Approved' | 'Rejected') {
    const { erpUrl, authHeader } = this.getAuth();
    try {
      // 1. Ambil data dokumen saat ini
      const getRes = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Leave Application/${encodeURIComponent(docName)}`,
          { headers: { Authorization: authHeader } },
        )
      );
      const doc = getRes.data.data;

      let approver = doc.leave_approver;
      if (!approver) {
        const hrRes = await this.getHrUsers();
        approver = hrRes.success && hrRes.data.length > 0 ? hrRes.data[0] : 'Administrator';
      }

      // TAHAP 1: SIMPAN DRAFT (Ubah Status ke Approved/Rejected) 
      await firstValueFrom(
        this.httpService.put(
          `${erpUrl}/api/resource/Leave Application/${encodeURIComponent(docName)}`,
          { status: status, leave_approver: approver },
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ),
      );

      // TAHAP 2: SUBMIT DOKUMEN (Ubah docstatus jadi 1) 
      await firstValueFrom(
        this.httpService.put(
          `${erpUrl}/api/resource/Leave Application/${encodeURIComponent(docName)}`,
          { docstatus: 1 },
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ),
      );

      return { success: true, message: `Izin berhasil ${status === 'Approved' ? 'disetujui' : 'ditolak'}.` };
    } catch (error: any) {
      console.error('[updateLeaveStatus] Error:', JSON.stringify(error.response?.data || error.message));
      
      let errMsg = `Gagal ${status === 'Approved' ? 'menyetujui' : 'menolak'} izin.`;
      
      const serverMsgs = error.response?.data?._server_messages;
      if (serverMsgs) {
        try {
          const parsedMsg = JSON.parse(JSON.parse(serverMsgs)[0]);
          if (parsedMsg.message) {
            errMsg = parsedMsg.message.replace(/<[^>]*>?/gm, ''); 
          }
        } catch (e) {}
      }
      
      throw new HttpException({ success: false, message: errMsg }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}