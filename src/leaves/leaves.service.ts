import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, catchError } from 'rxjs';

@Injectable()
export class LeavesService {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Mengurai (parsing) pesan error dari ERPNext
  // ─────────────────────────────────────────────────────────────────
  private parseErpError(error: any, fallbackMessage: string): string {
    const data = error.response?.data;
    if (!data) return fallbackMessage;

    // ERPNext sering mengirim pesan error di _server_messages (berupa array JSON strings)
    if (data._server_messages) {
      try {
        const messages = JSON.parse(data._server_messages);
        for (const msgStr of messages) {
          const msgObj = JSON.parse(msgStr);
          
          // Cek apakah ini OverlapError
          if (msgObj.message && msgObj.message.toLowerCase().includes('already applied')) {
            return 'Kamu sudah pernah mengajukan izin/cuti untuk rentang tanggal ini. Silakan cek riwayat pengajuanmu.';
          }
          // Kembalikan pesan merah pertama jika ada
          if (msgObj.message && msgObj.indicator === 'red') {
             // Hilangkan tag HTML jika ada
             return msgObj.message.replace(/<[^>]*>?/gm, '');
          }
        }
      } catch (e) {
        console.error('Failed to parse _server_messages', e);
      }
    }

    // Cek error standar ERPNext
    if (data.exception) {
       if (data.exception.includes('OverlapError')) {
           return 'Kamu sudah pernah mengajukan izin/cuti untuk rentang tanggal ini. Silakan cek riwayat pengajuanmu.';
       }
       if (data.exception.includes('InsufficientLeaveBalance')) {
           return 'Jatah cutimu tidak mencukupi untuk pengajuan ini.';
       }
    }

    return data.message || fallbackMessage;
  }

  async getLeaveInfo(employeeId: string) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL');
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');
    const headers = { Authorization: `token ${apiKey}:${apiSecret}` };

    try {
      // 1. Ambil Riwayat Pengajuan Cuti Karyawan
      const historyRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
          headers,
          params: {
            filters: JSON.stringify([['employee', '=', employeeId]]),
            fields: JSON.stringify(['name', 'leave_type', 'from_date', 'to_date', 'status', 'description']),
            order_by: 'creation desc',
            limit_page_length: 20
          }
        })
      );

      // 2. Ambil Jatah Awal (12 Hari) dari Leave Allocation
      const allocationRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Allocation`, {
          headers,
          params: {
            filters: JSON.stringify([
              ['employee', '=', employeeId],
              ['leave_type', '=', 'Cuti Tahunan'],
              ['docstatus', '=', 1]
            ]),
            fields: JSON.stringify(['total_leaves_allocated']),
            order_by: 'to_date desc',
            limit_page_length: 1
          }
        })
      );

      const totalCuti = allocationRes.data.data?.[0]?.total_leaves_allocated || 12;

      // 3. Hitung Cuti Terpakai (Status Approved)
      let terpakai = 0;
      historyRes.data.data.forEach((leave: any) => {
        if (leave.status === 'Approved' && leave.leave_type === 'Cuti Tahunan') {
          const from = new Date(leave.from_date);
          const to = new Date(leave.to_date);
          // Hitung hari, abaikan Sabtu (6) dan Minggu (0)
          for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
            if (d.getDay() !== 0 && d.getDay() !== 6) {
              terpakai++;
            }
          }
        }
      });

      return { 
        success: true, 
        history: historyRes.data.data, 
        balance: totalCuti - terpakai,
        total: totalCuti 
      };

    } catch (error: any) {
      console.error('>>> ERROR LEAVE INFO:', error.response?.data || error.message);
      return { success: false, history: [], balance: 0, total: 0 };
    }
  }

  // Fungsi pengajuan cuti ke ERPNext
  async createLeaveApplication(data: any) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL');
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');

    const payload = {
      doctype: 'Leave Application',
      employee: data.employee_id,
      leave_type: data.leave_type,
      from_date: data.from_date,
      to_date: data.to_date,
      description: data.reason,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(`${erpUrl}/api/resource/Leave Application`, payload, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
        }).pipe(
          catchError((error) => {
            console.error('>>> ERROR FRAPPE LEAVE:', JSON.stringify(error.response?.data));
            const cleanMessage = this.parseErpError(error, 'Gagal mengajukan cuti, silakan coba lagi nanti.');
            throw new HttpException(cleanMessage, HttpStatus.BAD_REQUEST);
          })
        )
      );

      return {
        success: true,
        message: 'Pengajuan berhasil dikirim dan menunggu approval',
        data: response.data.data,
      };

    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException('Gagal terhubung ke ERP', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}