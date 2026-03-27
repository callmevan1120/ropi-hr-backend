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

      // 2. Ambil Jatah Awal (12 Hari) dari Dokumen Leave Allocation
      const findAlloc = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Allocation`, {
          headers,
          params: {
            filters: JSON.stringify([
              ['employee', '=', employeeId],
              ['leave_type', '=', 'Cuti Tahunan'],
              ['docstatus', '=', 1] // Pastikan statusnya sudah Submitted
            ]),
            fields: JSON.stringify(['name', 'total_leaves_allocated']) 
          }
        })
      );

      let sisaCuti = 0;
      let totalCuti = 0;
      const allocDoc = findAlloc.data.data[0];

      if (allocDoc) {
        // Ini adalah jatah utuh (misal: 12 hari)
        totalCuti = allocDoc.total_leaves_allocated || 0;

        // 3. Hitung jumlah cuti yang SUDAH DIPAKAI dan DISETUJUI (Approved)
        const usedLeavesRes = await firstValueFrom(
          this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
            headers,
            params: {
              filters: JSON.stringify([
                ['employee', '=', employeeId],
                ['leave_type', '=', 'Cuti Tahunan'],
                ['status', '=', 'Approved'],
                ['docstatus', '=', 1]
              ]),
              fields: JSON.stringify(['total_leave_days'])
            }
          })
        );

        // Menjumlahkan semua hari cuti yang sudah pernah diambil
        const usedLeaves = usedLeavesRes.data.data.reduce((sum: number, leave: any) => sum + (leave.total_leave_days || 0), 0);
        
        // 4. SISA CUTI = Jatah Awal (12) - Cuti Terpakai (X)
        sisaCuti = totalCuti - usedLeaves;
      }

      return {
        success: true,
        history: historyRes.data.data.map((i: any) => ({
          ...i,
          reason: i.description
        })),
        balance: sisaCuti,
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
            throw new HttpException(error.response?.data?.message || 'Gagal mengajukan cuti', HttpStatus.BAD_REQUEST);
          })
        )
      );

      return { success: true, data: response.data.data };
    } catch (error) {
      throw new HttpException('Gagal menyimpan pengajuan ke sistem HR.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}