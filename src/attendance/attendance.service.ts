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
  // GET ACTIVE SHIFT — baca Shift Assignment aktif dari ERPNext
  // Endpoint: GET /api/attendance/active-shift?employee_id=xxx
  //
  // ERPNext Shift Assignment fields yang dipakai:
  //   employee, shift_type, start_date, end_date, docstatus
  //
  // Response:
  //   { success: true, shift_name: "Shift 1 [05.00-13.00]",
  //     start_time: "05:00", end_time: "13:00" }
  // ─────────────────────────────────────────────────────────────────
  async getActiveShift(employeeId: string) {
    const { erpUrl, authHeader } = this.getAuth();

    const nowUtc   = new Date();
    const wibTime  = new Date(nowUtc.getTime() + 7 * 60 * 60 * 1000);
    const yyyy     = wibTime.getUTCFullYear();
    const mm       = String(wibTime.getUTCMonth() + 1).padStart(2, '0');
    const dd       = String(wibTime.getUTCDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    try {
      // 1. Query Shift Assignment yang sedang aktif (mencakup hari ini, docstatus=1)
      const assignRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Assignment`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['employee',   '=',  employeeId],
              ['start_date', '<=', todayStr],
              ['docstatus',  '=',  1],          // hanya yang sudah di-submit
            ]),
            fields: JSON.stringify([
              'name', 'shift_type', 'start_date', 'end_date',
            ]),
            order_by:          'start_date desc',
            limit_page_length: 5,
          },
        }),
      );

      const assignments: any[] = assignRes.data.data ?? [];

      // 2. Filter: end_date null (open-ended) ATAU end_date >= hari ini
      const aktif = assignments.find(
        (a) => !a.end_date || a.end_date >= todayStr,
      );

      if (!aktif) {
        return {
          success: false,
          message: 'Tidak ada Shift Assignment aktif. Hubungi HRD.',
        };
      }

      // 3. Ambil detail jam dari Shift Type
      const shiftRes = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Shift Type/${encodeURIComponent(aktif.shift_type)}`,
          { headers: { Authorization: authHeader } },
        ),
      );

      const shiftData = shiftRes.data.data;

      // start_time / end_time dari ERPNext berbentuk "HH:MM:SS"
      const fmtTime = (raw: string | null): string => {
        if (!raw) return '00:00';
        // ERPNext kadang kirim "0 days HH:MM:SS" atau "HH:MM:SS"
        const parts = raw.split(' ');
        const timePart = parts[parts.length - 1]; // ambil bagian terakhir
        return timePart.substring(0, 5);           // "HH:MM"
      };

      return {
        success:    true,
        shift_name: aktif.shift_type,
        start_time: fmtTime(shiftData.start_time),
        end_time:   fmtTime(shiftData.end_time),
      };
    } catch (error: any) {
      console.error('[getActiveShift] Error:', error.response?.data || error.message);
      return {
        success: false,
        message: 'Gagal membaca Shift Assignment dari ERPNext.',
      };
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

      const inputTipe = (data.tipe || data.log_type || '').toUpperCase();
      const logType   = (inputTipe === 'KELUAR' || inputTipe === 'OUT') ? 'OUT' : 'IN';

      const branch = data.branch || '';

      // Semua karyawan (kantor & outlet) absen via PWA dengan foto selfie + timestamp + lokasi overlay.
      // Shift tidak dikirim dari frontend — ERPNext membaca dari Shift Assignment yang di-set HR.
      const payload: any = {
        employee:          data.employee_id,
        log_type:          logType,
        time:              timeString,
        latitude:          data.latitude,
        longitude:         data.longitude,
        custom_foto_absen: data.image_verification, // selfie + timestamp + lokasi overlay
        custom_signature:  data.custom_signature,
        device_id:         'RopiHR-PWA',
      };

      console.log(
        `[createCheckin] employee=${data.employee_id} logType=${logType} branch="${branch}"`,
      );

      const response = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Employee Checkin`,
          payload,
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ),
      );

      return {
        success: true,
        message: `Absen ${logType === 'IN' ? 'MASUK' : 'KELUAR'} berhasil!`,
        data:    response.data.data,
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
              // custom_verification_image tetap diambil untuk backward compat data lama
              'custom_verification_image',
            ]),
            order_by:          'time desc',
            limit_page_length: 100,
          },
        }),
      );
      return { success: true, data: response.data.data };
    } catch (error) {
      throw new HttpException(
        'Gagal mengambil riwayat absen dari ERPNext.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
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
            ]),
            order_by:          'time desc',
            limit_page_length: 500,
          },
        }),
      );
      return { success: true, data: response.data.data };
    } catch (error) {
      throw new HttpException(
        'Gagal mengambil semua riwayat absen.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET SHIFTS (untuk Shift.tsx — dropdown shift request)
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
    } catch (error) {
      throw new HttpException(
        'Gagal mengambil daftar Shift dari ERPNext.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
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
    } catch (error) {
      throw new HttpException(
        'Gagal mengambil daftar Tipe Izin dari ERPNext.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
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
    } catch (error: any) {
      console.error('getLeaveHistory error:', error.response?.data || error.message);
      throw new HttpException(
        'Gagal mengambil riwayat izin dari ERPNext.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // SUBMIT LEAVE REQUEST
  // ─────────────────────────────────────────────────────────────────
  async submitLeaveRequest(data: any) {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const payload = {
        employee:   data.employee_id,
        leave_type: data.leave_type,
        from_date:  data.from_date,
        to_date:    data.to_date,
        description: data.reason,
        status:     'Open',
        docstatus:  0,
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
              maxBodyLength:    Infinity,
              maxContentLength: Infinity,
            }),
          );

          console.log(`[Upload OK] Lampiran ${safeFileName} berhasil dikirim`);
        } catch (fileErr: any) {
          console.error('[Upload Gagal] Izin tersimpan, lampiran gagal:', fileErr.response?.data || fileErr.message);
        }
      }

      return {
        success: true,
        message: 'Izin berhasil diajukan beserta buktinya',
        data:    response.data.data,
      };
    } catch (error: any) {
      console.error('Leave Request Error:', error.response?.data || error.message);
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
  // GET HR USERS (untuk approver shift request)
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
  // SUBMIT SHIFT REQUEST (pengajuan tukar shift oleh karyawan)
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

      return {
        success: true,
        message: 'Shift Request berhasil diajukan ke HRD.',
        data:    response.data.data,
      };
    } catch (error: any) {
      console.error('Shift Request Error:', error.response?.data || error.message);
      throw new HttpException(
        'Gagal mengajukan Shift Request.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}