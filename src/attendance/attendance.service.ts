import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

function checkIsRamadhan(date: Date): boolean {
  const tahun = date.getUTCFullYear();
  const bulan = date.getUTCMonth() + 1;
  const tgl = date.getUTCDate();
  if (tahun === 2025 && bulan === 3 && tgl >= 1 && tgl <= 30) return true;
  if (tahun === 2026 && bulan === 2 && tgl >= 18) return true;
  if (tahun === 2026 && bulan === 3 && tgl <= 19) return true;
  return false;
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  // =============================================
  // HELPER — Upsert Shift Assignment untuk hari ini
  // Tahan banting terhadap TimestampMismatchError!
  // =============================================
  private async upsertShiftAssignment(
    employeeId: string,
    namaShift: string,
    tanggalStr: string,
    erpUrl: string,
    authHeader: string,
  ): Promise<void> {
    try {
      // 1. Cari Shift Assignment aktif untuk employee + tanggal hari ini
      const cariRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Assignment`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['employee', '=', employeeId],
              ['start_date', '<=', tanggalStr],
              ['docstatus', '!=', 2],
            ]),
            fields: JSON.stringify(['name', 'shift_type', 'start_date', 'end_date', 'docstatus']),
            limit_page_length: 10,
          },
        }),
      );

      const assignments: any[] = cariRes.data.data || [];
      const aktif = assignments.filter((a) => !a.end_date || a.end_date >= tanggalStr);

      // 2. Sudah ada assignment dengan shift yang sama & submitted → Selesai
      const sudahBenar = aktif.find((a) => a.shift_type === namaShift && a.docstatus === 1);
      if (sudahBenar) {
        console.log(`[ShiftAssignment] Sudah ada & benar: ${namaShift} untuk ${employeeId}`);
        return;
      }

      // 3. Batalkan (Cancel) assignment lama yang KONFLIK menggunakan PUT (Mencegah Timestamp Mismatch)
      const konflik = aktif.filter((a) => a.shift_type !== namaShift && a.docstatus === 1);
      for (const a of konflik) {
        try {
          await firstValueFrom(
            this.httpService.put(
              `${erpUrl}/api/resource/Shift Assignment/${a.name}`,
              { docstatus: 2 }, // 2 = Force Cancelled
              { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
            ),
          );
          console.log(`[ShiftAssignment] Cancelled lama: ${a.name} (${a.shift_type})`);
        } catch (e: any) {
          console.warn(`[ShiftAssignment] Gagal cancel ${a.name}:`, e.response?.data || e.message);
        }
      }

      // 4. Buat Shift Assignment baru dan langsung di-Submit (docstatus: 1)
      const buatRes = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Shift Assignment`,
          {
            employee: employeeId,
            shift_type: namaShift,
            start_date: tanggalStr,
            end_date: tanggalStr,
            company: 'PT. Juara Roti Indonesia',
            docstatus: 1, // Langsung Submit, jangan di-draft lalu di-submit pakai RPC
          },
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ),
      );

      console.log(`[ShiftAssignment] Buat & submit OK: ${namaShift} untuk ${employeeId} tgl ${tanggalStr}`);

    } catch (error: any) {
      console.error('[ShiftAssignment] Gagal upsert:', error.response?.data || error.message);
    }
  }

  async createCheckin(data: any) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';
    const authHeader = `token ${apiKey}:${apiSecret}`;

    try {
      // Waktu WIB (server Vercel UTC + 7 jam)
      const nowUtc = new Date();
      const wibTime = new Date(nowUtc.getTime() + (7 * 60 * 60 * 1000));
      const timeString = wibTime.toISOString().replace('T', ' ').substring(0, 19);

      // Tanggal WIB untuk Shift Assignment (YYYY-MM-DD)
      const yyyy = wibTime.getUTCFullYear();
      const mm   = String(wibTime.getUTCMonth() + 1).padStart(2, '0');
      const dd   = String(wibTime.getUTCDate()).padStart(2, '0');
      const tanggalStr = `${yyyy}-${mm}-${dd}`;

      const inputTipe = (data.tipe || data.log_type || '').toUpperCase();
      const logType = (inputTipe === 'KELUAR' || inputTipe === 'OUT') ? 'OUT' : 'IN';

      const branch = data.branch || 'PH Klaten';
      const day = wibTime.getUTCDay(); // Pasti mengikuti hari WIB
      const isHariKerja = day >= 1 && day <= 5;

      const isRamadhan = checkIsRamadhan(wibTime);
      const branchLabel = branch.toLowerCase().includes('jakarta') ? 'Jakarta' : 'PH Klaten';
      const periodeLabel = isRamadhan ? 'Ramadhan' : 'Non Ramadhan';

      let finalShift: string;
      if (day === 5) {
        finalShift = `Jumat (${branchLabel} ${periodeLabel})`;
      } else {
        finalShift = `Senin - Kamis (${branchLabel} ${periodeLabel})`;
      }

      console.log(`[createCheckin] employee=${data.employee_id} logType=${logType} branch="${branch}" day=${day} isHariKerja=${isHariKerja} shift="${finalShift}" tanggal=${tanggalStr}`);

      // Upsert Shift Assignment hanya saat MASUK di hari kerja
      if (logType === 'IN' && isHariKerja) {
        await this.upsertShiftAssignment(data.employee_id, finalShift, tanggalStr, erpUrl, authHeader);
      }

      const payload = {
        employee: data.employee_id,
        log_type: logType,
        time: timeString,
        latitude: data.latitude,
        longitude: data.longitude,
        custom_foto_absen: data.image_verification,
        custom_verification_image: data.custom_verification_image,
        custom_signature: data.custom_signature,
        shift: finalShift,
        device_id: 'RopiHR-PWA',
      };

      const response = await firstValueFrom(
        this.httpService.post(`${erpUrl}/api/resource/Employee Checkin`, payload, {
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json',
          },
        })
      );

      return {
        success: true,
        message: `Absen ${logType === 'IN' ? 'MASUK' : 'KELUAR'} berhasil!`,
        data: response.data.data,
      };
    } catch (error: any) {
      console.error('Checkin Error:', error.response?.data || error.message);
      throw new HttpException('Gagal menyimpan absen ke sistem HR.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async getHistory(employeeId: string, from: string, to: string) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Employee Checkin`, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
          params: {
            filters: JSON.stringify([
              ['employee', '=', employeeId],
              ['time', '>=', `${from} 00:00:00`],
              ['time', '<=', `${to} 23:59:59`],
            ]),
            fields: JSON.stringify([
              'name', 'employee', 'log_type', 'time',
              'custom_foto_absen', 'custom_verification_image', 'custom_signature', 'shift'
            ]),
            order_by: 'time desc',
            limit_page_length: 100,
          },
        })
      );
      return { success: true, data: response.data.data };
    } catch (error) {
      throw new HttpException('Gagal mengambil riwayat absen dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async getAllHistory(from: string, to: string) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Employee Checkin`, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
          params: {
            filters: JSON.stringify([
              ['time', '>=', `${from} 00:00:00`],
              ['time', '<=', `${to} 23:59:59`],
            ]),
            fields: JSON.stringify([
              'name', 'employee', 'employee_name', 'log_type', 'time',
              'custom_foto_absen', 'custom_verification_image', 'custom_signature', 'shift',
              'latitude', 'longitude'
            ]),
            order_by: 'time desc',
            limit_page_length: 5000,
          },
        })
      );
      return { success: true, data: response.data.data };
    } catch (error) {
      throw new HttpException('Gagal mengambil data absen semua karyawan.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async getShifts() {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Type`, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
          params: {
            fields: JSON.stringify(['name', 'start_time', 'end_time']),
            limit_page_length: 200,
          },
        })
      );
      return { success: true, data: response.data.data };
    } catch (error) {
      throw new HttpException('Gagal mengambil daftar Shift dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async getLeaveTypes() {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Type`, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
          params: {
            fields: JSON.stringify(['name']),
            limit_page_length: 50,
          },
        })
      );
      return { success: true, data: response.data.data };
    } catch (error) {
      throw new HttpException('Gagal mengambil daftar Tipe Izin dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async proxyFile(filePath: string): Promise<{ buffer: Buffer; contentType: string }> {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';

    const url = `${erpUrl}${filePath}`;
    const response = await firstValueFrom(
      this.httpService.get(url, {
        headers: { Authorization: `token ${apiKey}:${apiSecret}` },
        responseType: 'arraybuffer',
      })
    );

    const contentType = response.headers['content-type'] || 'image/jpeg';
    return { buffer: Buffer.from(response.data), contentType };
  }

  async getLeaveHistory(employeeId: string) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';
    const authHeader = `token ${apiKey}:${apiSecret}`;

    try {
      const leaveRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([['employee', '=', employeeId]]),
            fields: JSON.stringify([
              'name', 'leave_type', 'from_date', 'to_date', 'description', 'status', 'total_leave_days',
            ]),
            order_by: 'from_date desc',
            limit_page_length: 50,
          },
        })
      );

      const leaveList: any[] = leaveRes.data.data;
      if (!leaveList || leaveList.length === 0) return { success: true, data: [] };

      const docNames = leaveList.map((l) => l.name);

      const fileRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/File`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['attached_to_doctype', '=', 'Leave Application'],
              ['attached_to_name', 'in', docNames],
            ]),
            fields: JSON.stringify(['name', 'file_url', 'attached_to_name']),
            limit_page_length: 200,
          },
        })
      );

      const attachmentMap: Record<string, string> = {};
      const fileList: any[] = fileRes.data.data ?? [];
      for (const file of fileList) {
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
      throw new HttpException('Gagal mengambil riwayat izin dari ERPNext.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async submitLeaveRequest(data: any) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';
    const authHeader = `token ${apiKey}:${apiSecret}`;

    try {
      const payload = {
        employee: data.employee_id,
        leave_type: data.leave_type,
        from_date: data.from_date,
        to_date: data.to_date,
        description: data.reason,
        status: 'Open',
        docstatus: 0,
      };

      const response = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Leave Application`,
          payload,
          {
            headers: {
              Authorization: authHeader,
              'Content-Type': 'application/json',
              Accept: 'application/json',
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

          const mimeType = matches[1];
          const pureBase64 = matches[2];
          const fileBuffer = Buffer.from(pureBase64, 'base64');

          const extMap: Record<string, string> = {
            'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
            'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf',
          };
          const ext = extMap[mimeType] ?? 'jpg';
          const safeFileName = `Bukti_${docName.replace(/-/g, '_')}.${ext}`;
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
                Authorization: authHeader,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': bodyBuffer.length.toString(),
              },
              maxBodyLength: Infinity,
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
        data: response.data.data,
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
}