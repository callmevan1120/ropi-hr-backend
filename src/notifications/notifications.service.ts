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

  private getAuth() {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL');
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');
    return { erpUrl, headers: { Authorization: `token ${apiKey}:${apiSecret}` } };
  }

  async getNotifications(employeeId: string) {
    const { erpUrl, headers } = this.getAuth();

    try {
      // 1. AMBIL RIWAYAT CUTI / IZIN
      const leaveRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
          headers,
          params: {
            filters: JSON.stringify([['employee', '=', employeeId]]),
            fields: JSON.stringify(['name', 'leave_type', 'status', 'modified', 'from_date']),
            order_by: 'modified desc',
            limit_page_length: 5
          }
        })
      );

      // 2. AMBIL RIWAYAT ABSEN MASUK (UNTUK CEK TELAT LAMA)
      const attendRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Employee Checkin`, {
          headers,
          params: {
            filters: JSON.stringify([['employee', '=', employeeId], ['log_type', '=', 'IN']]),
            fields: JSON.stringify(['name', 'time', 'shift', 'creation']),
            order_by: 'creation desc',
            limit_page_length: 5
          }
        })
      );

      // PROSES NOTIFIKASI CUTI
      const leaveNotifs = (leaveRes.data.data || []).map(l => ({
        id: l.name,
        title: `Status ${l.leave_type}`,
        message: l.status === 'Approved' ? `Hore! Pengajuan ${l.leave_type} kamu disetujui HRD.` : 
                 l.status === 'Rejected' ? `Maaf, pengajuan ${l.leave_type} kamu ditolak.` :
                 `Pengajuan ${l.leave_type} sedang diproses.`,
        time: l.modified,
        type: l.status === 'Approved' ? 'success' : l.status === 'Rejected' ? 'error' : 'info'
      }));

      // PROSES NOTIFIKASI TELAT (Threshold di set jam 07:35 agar fleksibel)
      const lateNotifs = (attendRes.data.data || []).filter(a => {
        const jam = a.time.split(' ')[1].substring(0, 5);
        return jam > "07:35"; 
      }).map(a => ({
        id: `db-late-${a.name}`,
        title: 'Riwayat Terlambat',
        message: `Kamu tercatat telat absen pada tanggal ${a.time.split(' ')[0]}.`,
        time: a.creation,
        type: 'error'
      }));

      // GABUNGKAN DAN URUTKAN BERDASARKAN WAKTU TERBARU
      const allNotifs = [...leaveNotifs, ...lateNotifs].sort((a, b) => 
        new Date(b.time).getTime() - new Date(a.time).getTime()
      );

      return { success: true, data: allNotifs };
    } catch (error) {
      console.error('Error fetching notifications:', error.response?.data || error.message);
      return { success: false, data: [] };
    }
  }
}