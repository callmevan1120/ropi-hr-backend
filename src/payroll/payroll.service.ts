import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, catchError } from 'rxjs';

@Injectable()
export class PayrollService {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  // 1. Ambil Daftar Slip Gaji Karyawan
  async getSlips(employeeId: string) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL');
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');
    const authHeader = `token ${apiKey}:${apiSecret}`;

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Salary Slip`, {
          headers: { Authorization: authHeader },
          params: {
            // docstatus = 1 artinya dokumen sudah di-Submit (Disahkan HR/Keuangan)
            filters: JSON.stringify([
              ['employee', '=', employeeId],
              ['docstatus', '=', 1]
            ]),
            fields: JSON.stringify(['name', 'start_date', 'end_date', 'net_pay', 'status']),
            order_by: 'start_date desc',
            limit_page_length: 24, // Ditingkatkan ke 24 (2 Tahun) agar karyawan lebih puas
          },
        })
      );

      return {
        success: true,
        data: response.data.data || [],
      };
    } catch (error: any) {
      console.error('>>> ERROR GET SLIPS:', error.response?.data || error.message);
      return { success: false, data: [] };
    }
  }

  // 2. Stream PDF Slip Gaji langsung dari ERPNext (Optimasi RAM Vercel)
  // Nama fungsi diubah agar cocok dengan pemanggilan di Controller
  async streamSlipPdf(slipId: string): Promise<any> {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL');
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');
    const authHeader = `token ${apiKey}:${apiSecret}`;

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/method/frappe.utils.print_format.download_pdf`, {
          headers: { Authorization: authHeader },
          params: {
            doctype: 'Salary Slip',
            name: slipId,
            no_letterhead: 0
          },
          // SANGAT PENTING: responseType diubah menjadi stream agar Vercel tidak kehabisan RAM
          responseType: 'stream', 
        }).pipe(
          catchError((error) => {
            console.error('>>> ERROR DOWNLOAD STREAM PDF:', error.response?.data || error.message);
            throw new HttpException('Gagal mengunduh PDF dari ERPNext', HttpStatus.BAD_REQUEST);
          })
        )
      );

      // Kembalikan objek Stream secara langsung
      return response.data;
    } catch (error) {
      throw new HttpException('Terjadi kesalahan saat mengambil PDF', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}