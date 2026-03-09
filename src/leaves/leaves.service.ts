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
      // 1. Ambil Riwayat Pengajuan (Field standar biasanya aman)
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

      // 2. Cari ID (Name) Dokumen Alokasi
      // Kita hanya memanggil field 'name' agar tidak memicu DataError
      const findAlloc = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Leave Allocation`, {
          headers,
          params: {
            filters: JSON.stringify([
              ['employee', '=', employeeId],
              ['leave_type', '=', 'Cuti Tahunan'],
              ['docstatus', '=', 1]
            ]),
            fields: JSON.stringify(['name']) 
          }
        })
      );

      let sisaCuti = 0;
      const allocId = findAlloc.data.data[0]?.name;

      // 3. Ambil Dokumen Secara Utuh (Jalur Bypass Virtual Field)
      if (allocId) {
        const fullDoc = await firstValueFrom(
          this.httpService.get(`${erpUrl}/api/resource/Leave Allocation/${allocId}`, { headers })
        );
        // Field 'remaining_leaves' akan muncul di sini karena dokumen dibuka secara individu
        sisaCuti = fullDoc.data.data.remaining_leaves || 0;
      }

      return {
        success: true,
        history: historyRes.data.data.map(i => ({
          ...i,
          reason: i.description
        })),
        balance: sisaCuti
      };

    } catch (error) {
      console.error('>>> ERROR LEAVE INFO:', error.response?.data || error.message);
      return { success: false, history: [], balance: 0 };
    }
  }

  // Fungsi pengajuan (tetap dipertahankan di Backend meskipun FE saat ini Monitoring Only)
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