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
  //
  // Shift Type ERPNext (dari Shift_Type.xlsx):
  //   "Senin - Kamis (PH Klaten Non Ramadhan)"  07:30–16:30
  //   "Senin - Kamis (PH Klaten Ramadhan)"      07:00–15:30
  //   "Jumat (PH Klaten Non Ramadhan)"           07:30–17:00
  //   "Jumat (PH Klaten Ramadhan)"               07:00–16:00
  //   (sama untuk Jakarta)
  //
  // Satpam TIDAK punya Shift Type terpisah di ERPNext.
  // Jam Satpam (30 mnt lebih awal/lambat) hanya berlaku di tampilan frontend.
  // Shift Assignment yang dibuat untuk Satpam tetap pakai nama shift kantor biasa.
  //
  // Format yang mungkin diterima dari frontend:
  //   BARU (dengan kurung) : "Senin - Kamis (PH Klaten Non Ramadhan)"  ← sudah benar
  //   LAMA (tanpa kurung)  : "Senin - Kamis PH Klaten Non Ramadhan"    ← perlu konversi
  // ─────────────────────────────────────────────────────────────────
  private normalizeOfficeShiftName(shiftName: string): string {
    if (!shiftName) return shiftName;

    // Strip label Satpam jika ada (Satpam tidak punya shift terpisah di ERPNext)
    let name = shiftName.trim().replace(/\s+Satpam\s*$/i, '').trim();

    // Jika sudah dalam format ERPNext (ada tanda kurung) → langsung return
    if (name.includes('(') && name.includes(')')) return name;

    // Konversi format lama "Senin - Kamis PH Klaten Non Ramadhan"
    // ke format baru  "Senin - Kamis (PH Klaten Non Ramadhan)"
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
              ['docstatus',   'in', [0, 1]], // Draft atau Submitted
            ]),
            fields:            JSON.stringify(['name', 'start_date', 'end_date', 'docstatus']),
            limit_page_length: 5,
          },
        }),
      );

      const assignments: any[] = res.data.data ?? [];
      return assignments.some(
        (a) => !a.end_date || a.end_date >= dateStr,
      );
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // CORE: Buat dan Submit Shift Assignment otomatis
  //
  // Flow:
  //  1. Cek apakah sudah ada Shift Assignment aktif yang cocok
  //  2. Jika belum ada → buat (POST) → submit (PUT docstatus=1)
  //  3. Return nama dokumen yang dibuat / sudah ada
  // ─────────────────────────────────────────────────────────────────
  private async ensureShiftAssignment(
    erpUrl: string,
    authHeader: string,
    employeeId: string,
    shiftType: string,
    dateStr: string,
  ): Promise<{ created: boolean; docName: string | null; error?: string }> {
    try {
      // 1. Cek existing
      const alreadyExists = await this.hasExistingShiftAssignment(
        erpUrl, authHeader, employeeId, shiftType, dateStr,
      );

      if (alreadyExists) {
        console.log(`[ShiftAssignment] Sudah ada untuk ${employeeId} – ${shiftType} – ${dateStr}`);
        return { created: false, docName: null };
      }

      // 2. Buat Shift Assignment (docstatus=0 = Draft)
      const createPayload = {
        employee:   employeeId,
        shift_type: shiftType,
        start_date: dateStr,
        end_date:   dateStr,   // Hanya 1 hari
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
      console.log(`[ShiftAssignment] Dibuat: ${docName}`);

      // 3. Submit (docstatus=1) agar ERPNext mengenali sebagai shift aktif
      await firstValueFrom(
        this.httpService.put(
          `${erpUrl}/api/resource/Shift Assignment/${encodeURIComponent(docName)}`,
          { docstatus: 1 },
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ),
      );

      console.log(`[ShiftAssignment] Submitted: ${docName}`);
      return { created: true, docName };

    } catch (error: any) {
      const errMsg = JSON.stringify(error.response?.data || error.message);
      console.error('[ShiftAssignment] Gagal:', errMsg);
      // Jangan throw – biarkan absensi tetap berjalan walau shift assignment gagal
      return { created: false, docName: null, error: errMsg };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GET ACTIVE SHIFT (Cari Shift Assignment yang di-ACC hari ini)
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
            limit_page_length: 5,
          },
        }),
      );

      const assignments: any[] = assignRes.data.data ?? [];
      const aktif = assignments.find((a) => !a.end_date || a.end_date >= todayStr);

      if (!aktif) {
        return {
          success: false,
          message: 'Belum ada Shift. Silakan Ajukan Shift ke HRD.',
        };
      }

      const shiftRes = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Shift Type/${encodeURIComponent(aktif.shift_type)}`,
          { headers: { Authorization: authHeader } },
        ),
      );

      const shiftData = shiftRes.data.data;
      const fmtTime = (raw: string | null): string => {
        if (!raw) return '00:00';
        const parts = raw.split(' ');
        return parts[parts.length - 1].substring(0, 5);
      };

      return {
        success:    true,
        shift_name: aktif.shift_type,
        start_time: fmtTime(shiftData.start_time),
        end_time:   fmtTime(shiftData.end_time),
      };
    } catch (error: any) {
      console.error('[getActiveShift] Error:', error.response?.data || error.message);
      return { success: false, message: 'Gagal membaca Shift dari ERPNext.' };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // CREATE CHECKIN  ← MAIN CHANGE: auto-create Shift Assignment
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

      // ── Normalisasi nama shift ──────────────────────────────────
      let shiftName: string = data.shift ?? '';

      if (shiftName && this.isOfficeShift(shiftName)) {
        // Shift kantor: konversi ke format ERPNext dengan tanda kurung
        shiftName = this.normalizeOfficeShiftName(shiftName);
      }
      // Shift outlet: gunakan apa adanya (sudah nama ERPNext)

      // ── Pastikan Shift Assignment ada & di-submit SEBELUM checkin ──
      let shiftAssignmentInfo: { created: boolean; docName: string | null; error?: string } =
        { created: false, docName: null };

      if (shiftName) {
        shiftAssignmentInfo = await this.ensureShiftAssignment(
          erpUrl, authHeader, data.employee_id, shiftName, todayStr,
        );

        if (shiftAssignmentInfo.error) {
          console.warn(
            `[Checkin] Shift Assignment gagal dibuat untuk ${data.employee_id}. ` +
            `Absensi tetap dilanjutkan. Error: ${shiftAssignmentInfo.error}`,
          );
        }
      } else {
        console.warn('[Checkin] shift kosong – skip pembuatan Shift Assignment.');
      }

      // ── Kirim Employee Checkin ke ERPNext ──────────────────────
      const payload: any = {
        employee:                  data.employee_id,
        log_type:                  logType,
        time:                      timeString,
        latitude:                  data.latitude,
        longitude:                 data.longitude,
        custom_foto_absen:         data.image_verification,
        custom_verification_image: data.custom_verification_image,
        custom_signature:          data.custom_signature,
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
              'custom_verification_image',
            ]),
            order_by:          'time desc',
            limit_page_length: 100,
          },
        }),
      );
      return { success: true, data: response.data.data };
    } catch {
      throw new HttpException('Gagal mengambil riwayat absen.', HttpStatus.INTERNAL_SERVER_ERROR);
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
              'custom_foto_absen', 'custom_verification_image', 'custom_signature', 'shift',
              'latitude', 'longitude',
            ]),
            order_by:          'time desc',
            limit_page_length: 5000,
          },
        }),
      );
      return { success: true, data: response.data.data };
    } catch {
      throw new HttpException('Gagal mengambil semua data absen.', HttpStatus.INTERNAL_SERVER_ERROR);
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
      throw new HttpException('Gagal menarik Shift.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

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
      throw new HttpException('Gagal menarik Tipe Izin.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

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

  async getLeaveHistory(employeeId: string) {
    const { erpUrl, authHeader } = this.getAuth();

    try {
      const leaveRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
          headers: { Authorization: authHeader },
          params: {
            filters:           JSON.stringify([['employee', '=', employeeId]]),
            fields:            JSON.stringify(['name', 'leave_type', 'from_date', 'to_date', 'description', 'status', 'total_leave_days']),
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
            filters:           JSON.stringify([
              ['attached_to_doctype', '=',  'Leave Application'],
              ['attached_to_name',    'in',  docNames],
            ]),
            fields:            JSON.stringify(['name', 'file_url', 'attached_to_name']),
            limit_page_length: 200,
          },
        }),
      );

      const attachmentMap: Record<string, string> = {};
      for (const file of fileRes.data.data ?? []) {
        if (!attachmentMap[file.attached_to_name]) attachmentMap[file.attached_to_name] = file.file_url;
      }

      const result = leaveList.map((leave) => ({
        ...leave,
        attachment: attachmentMap[leave.name] ?? null,
      }));
      return { success: true, data: result };
    } catch {
      throw new HttpException('Gagal menarik izin.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async submitLeaveRequest(data: any) {
    const { erpUrl, authHeader } = this.getAuth();
    try {
      const payload = {
        employee:    data.employee_id,
        leave_type:  data.leave_type,
        from_date:   data.from_date,
        to_date:     data.to_date,
        description: data.reason,
        status:      'Open',
        docstatus:   0,
      };

      const response = await firstValueFrom(
        this.httpService.post(`${erpUrl}/api/resource/Leave Application`, payload, {
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        }),
      );

      const docName = response.data.data.name;

      if (docName && data.attachment) {
        try {
          const matches = data.attachment.match(/^data:([A-Za-z0-9+\/]+\/[A-Za-z0-9+\/]+);base64,(.+)$/);
          if (!matches) throw new Error('Format base64 salah');
          const mimeType   = matches[1];
          const fileBuffer = Buffer.from(matches[2], 'base64');
          const extMap: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png' };
          const ext          = extMap[mimeType] ?? 'jpg';
          const safeFileName = `Bukti_${docName.replace(/-/g, '_')}.${ext}`;
          const boundary     = `----FormBoundary${Date.now()}`;

          const beforeFile = [
            `--${boundary}`,
            `Content-Disposition: form-data; name="file"; filename="${safeFileName}"`,
            `Content-Type: ${mimeType}`,
            '',
            '',
          ].join('\r\n');
          const afterFile = [
            '',
            `--${boundary}`,
            `Content-Disposition: form-data; name="is_private"`,
            '',
            '0',
            `--${boundary}`,
            `Content-Disposition: form-data; name="doctype"`,
            '',
            'Leave Application',
            `--${boundary}`,
            `Content-Disposition: form-data; name="docname"`,
            '',
            docName,
            `--${boundary}--`,
            '',
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
        } catch (e: any) {
          console.error('Upload Gagal:', e.message);
        }
      }
      return { success: true, message: 'Berhasil.', data: response.data.data };
    } catch (error: any) {
      const errorString = JSON.stringify(error.response?.data || {});
      if (errorString.includes('Overlap'))    throw new HttpException('Sudah ada izin.', HttpStatus.BAD_REQUEST);
      else if (errorString.includes('allocation')) throw new HttpException('Kuota habis.', HttpStatus.BAD_REQUEST);
      else throw new HttpException('Gagal submit izin.', HttpStatus.INTERNAL_SERVER_ERROR);
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
        employee:   data.employee_id,
        shift_type: data.shift_type,
        from_date:  data.from_date,
        to_date:    data.to_date,
        approver:   data.approver,
        status:     'Draft',
        docstatus:  0,
      };

      const response = await firstValueFrom(
        this.httpService.post(`${erpUrl}/api/resource/Shift Request`, payload, {
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        }),
      );
      return { success: true, message: 'Berhasil.', data: response.data.data };
    } catch {
      throw new HttpException('Gagal mengajukan Shift Request.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}