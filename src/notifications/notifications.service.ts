import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async getNotifications(employeeId: string) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL');
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');
    const headers = { Authorization: `token ${apiKey}:${apiSecret}` };

    try {
      // Menarik 10 perubahan terbaru dari Cuti / Izin Karyawan
      const leaveRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
          headers,
          params: {
            filters: JSON.stringify([['employee', '=', employeeId]]),
            fields: JSON.stringify(['name', 'leave_type', 'status', 'modified', 'from_date']),
            order_by: 'modified desc',
            limit_page_length: 10
          }
        })
      );

      const leaves = leaveRes.data.data || [];
      const notifs = leaves.map(l => {
        let message = '';
        let isSuccess = false;
        let isError = false;
        
        if (l.status === 'Approved') {
          message = `Hore! Pengajuan ${l.leave_type} kamu disetujui HRD.`;
          isSuccess = true;
        } else if (l.status === 'Rejected') {
          message = `Maaf, pengajuan ${l.leave_type} kamu ditolak.`;
          isError = true;
        } else {
          message = `Pengajuan ${l.leave_type} sedang menunggu persetujuan.`;
        }

        return {
          id: l.name,
          title: `Status ${l.leave_type}`,
          message: message,
          time: l.modified, // Format Waktu dari ERPNext
          type: isSuccess ? 'success' : isError ? 'error' : 'info'
        };
      });

      return { success: true, data: notifs };
    } catch (error) {
      console.error('Error fetching notifications:', error);
      return { success: false, data: [] };
    }
  }
}