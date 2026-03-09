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
      const now = new Date();
      const timeString = new Date(now.getTime() - (now.getTimezoneOffset() * 60000))
        .toISOString().slice(0, 19).replace('T', ' ');

      const inputTipe = (data.tipe || data.log_type || '').toUpperCase();
      const logType = (inputTipe === 'KELUAR' || inputTipe === 'OUT') ? 'OUT' : 'IN';

      let finalShift = data.shift;
      const branch = data.branch || 'PH Klaten';
      const day = now.getDay();

      const isRamadhan = checkIsRamadhan(now);
      const branchLabel = branch.includes('Jakarta') ? 'Jakarta' : 'PH Klaten';
      const periodeLabel = isRamadhan ? 'Ramadhan' : 'Non Ramadhan';

      if (day >= 1 && day <= 4) {
        finalShift = `Senin - Kamis (${branchLabel} ${periodeLabel})`;
      } else if (day === 5) {
        finalShift = `Jumat (${branchLabel} ${periodeLabel})`;
      } else {
        finalShift = `Senin - Kamis (${branchLabel} ${periodeLabel})`;
      }

      const payload = {
        employee: data.employee_id,
        log_type: logType,
        time: timeString,
        latitude: data.latitude,
        longitude: data.longitude,
        custom_foto_absen: data.image_verification,
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
            fields: JSON.stringify(['name', 'employee', 'log_type', 'time', 'custom_foto_absen', 'shift']),
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
  // ✨ RIWAYAT IZIN ✨
  // ══════════════════════════════════════════════════
  async getLeaveHistory(employeeId: string) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
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
      return { success: true, data: response.data.data };
    } catch (error) {
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

      // ── STEP 2: Upload foto pakai multipart/form-data ke /api/method/upload_file ──
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