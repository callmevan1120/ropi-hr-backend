import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

// ══════════════════════════════════════
// HELPER: CEK RAMADHAN DINAMIS
// ══════════════════════════════════════
function checkIsRamadhan(date: Date): boolean {
  const tahun = date.getFullYear();
  const bulan = date.getMonth() + 1;
  const tgl = date.getDate();

  // Ramadhan 2025: 1 Mar – 30 Mar
  if (tahun === 2025 && bulan === 3 && tgl >= 1 && tgl <= 30) return true;
  // Ramadhan 2026: 18 Feb – 19 Mar
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

  async createCheckin(data: any) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';

    try {
      // 🔥 FIX JAM: Paksa server Vercel (UTC) untuk tambah 7 jam menjadi WIB
      const nowUtc = new Date();
      const wibTime = new Date(nowUtc.getTime() + (7 * 60 * 60 * 1000));
      // Hasilnya presisi WIB: "2026-03-11 11:50:00"
      const timeString = wibTime.toISOString().replace('T', ' ').substring(0, 19);

      const inputTipe = (data.tipe || data.log_type || '').toUpperCase();
      const logType = (inputTipe === 'KELUAR' || inputTipe === 'OUT') ? 'OUT' : 'IN';

      let finalShift = data.shift;
      const branch = data.branch || 'PH Klaten';
      const day = wibTime.getDay(); // Pakai hari WIB juga biar shiftnya akurat

      const isRamadhan = checkIsRamadhan(wibTime);
      const branchLabel = branch.includes('Jakarta') ? 'Jakarta' : 'PH Klaten';
      const periodeLabel = isRamadhan ? 'Ramadhan' : 'Non Ramadhan';

      if (day >= 1 && day <= 4) {
        finalShift = `Senin - Kamis (${branchLabel} ${periodeLabel})`;
      } else if (day === 5) {
        finalShift = `Jumat (${branchLabel} ${periodeLabel})`;
      } else {
        finalShift = `Senin - Kamis (${branchLabel} ${periodeLabel})`;
      }

      // 🔥 FIX FOTO: Kirim 2 Foto Base64 (Selfie & Mesin) langsung ke ERPNext
      const payload = {
        employee: data.employee_id,
        log_type: logType,
        time: timeString,
        latitude: data.latitude,
        longitude: data.longitude,
        custom_foto_absen: data.image_verification,     // Foto 1: Muka/Selfie
        custom_validasi_foto: data.validasi_foto,       // Foto 2: Bukti Mesin Fingerprint
        shift: finalShift,
        device_id: 'Vite-React-App',
      };

      const response = await firstValueFrom(
        this.httpService.post(`${erpUrl}/api/resource/Employee Checkin`, payload, {
          headers: {
            'Authorization': `token ${apiKey}:${apiSecret}`,
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
            // 🔥 UPDATE: Tambahkan field custom_validasi_foto di getHistory
            fields: JSON.stringify([
              'name', 'employee', 'log_type', 'time', 
              'custom_foto_absen', 'custom_validasi_foto', 'shift'
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

  // ══════════════════════════════════════════════════
  // ✨ PROXY FILE — hindari Mixed Content HTTPS vs HTTP ✨
  // ══════════════════════════════════════════════════
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

  // ══════════════════════════════════════════════════
  // ✨ RIWAYAT IZIN — dengan attachment dari File doctype ✨
  // ══════════════════════════════════════════════════
  async getLeaveHistory(employeeId: string) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';
    const authHeader = `token ${apiKey}:${apiSecret}`;

    try {
      // STEP 1: Ambil daftar Leave Application
      const leaveRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['employee', '=', employeeId],
            ]),
            fields: JSON.stringify([
              'name',
              'leave_type',
              'from_date',
              'to_date',
              'description',
              'status',
              'total_leave_days',
            ]),
            order_by: 'from_date desc',
            limit_page_length: 50,
          },
        })
      );

      const leaveList: any[] = leaveRes.data.data;

      if (!leaveList || leaveList.length === 0) {
        return { success: true, data: [] };
      }

      // STEP 2: Ambil semua attachment dari doctype File
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

      // STEP 3: Gabungkan attachment ke masing-masing leave record
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

  // ══════════════════════════════════════════════════
  // ✨ LOGIKA FINAL: IZIN DENGAN UPLOAD FOTO ✨
  // ══════════════════════════════════════════════════
  async submitLeaveRequest(data: any) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';
    const authHeader = `token ${apiKey}:${apiSecret}`;

    try {
      // ── STEP 1: Buat Leave Application dulu ──
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

      // ── STEP 2: Upload foto izin pakai multipart/form-data (Biarkan ini tetap file fisik, tidak perlu diubah) ──
      if (docName && data.attachment) {
        try {
          const matches = data.attachment.match(
            /^data:([A-Za-z0-9+\/]+\/[A-Za-z0-9+\/]+);base64,(.+)$/,
          );

          if (!matches) {
            throw new Error('Format base64 tidak valid dari frontend');
          }

          const mimeType = matches[1];
          const pureBase64 = matches[2];
          const fileBuffer = Buffer.from(pureBase64, 'base64');

          const extMap: Record<string, string> = {
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'application/pdf': 'pdf',
          };
          const ext = extMap[mimeType] ?? 'jpg';
          const safeFileName = `Bukti_${docName.replace(/-/g, '_')}.${ext}`;

          const boundary = `----FormBoundary${Date.now()}`;

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
            this.httpService.post(
              `${erpUrl}/api/method/upload_file`,
              bodyBuffer,
              {
                headers: {
                  Authorization: authHeader,
                  'Content-Type': `multipart/form-data; boundary=${boundary}`,
                  'Content-Length': bodyBuffer.length,
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
              },
            ),
          );

          console.log(`[✅ Upload OK] Lampiran ${safeFileName} berhasil dikirim ke ERPNext`);
        } catch (fileErr: any) {
          console.error(
            '[⚠️ Upload Gagal] Izin tetap tersimpan, tapi lampiran gagal:',
            fileErr.response?.data || fileErr.message,
          );
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
        throw new HttpException(
          'Gagal: Sudah ada izin di tanggal tersebut.',
          HttpStatus.BAD_REQUEST,
        );
      } else if (errorString.includes('allocation')) {
        throw new HttpException(
          'Gagal: Kuota izin tidak mencukupi.',
          HttpStatus.BAD_REQUEST,
        );
      } else {
        throw new HttpException(
          'Gagal menyimpan pengajuan izin.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }
  }
}