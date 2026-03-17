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
            limit_page_length: 12 // Ambil 12 bulan terakhir
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

  // 2. Download PDF Slip Gaji langsung dari ERPNext
  async downloadSlipPdf(slipId: string): Promise<Buffer> {
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
            // format: 'Standard', // Optional, ERPNext akan pakai default jika tidak diisi
            no_letterhead: 0
          },
          responseType: 'arraybuffer', // SANGAT PENTING: Agar PDF tidak rusak saat diterima
        }).pipe(
          catchError((error) => {
            console.error('>>> ERROR DOWNLOAD PDF:', error.response?.data || error.message);
            throw new HttpException('Gagal mengunduh PDF dari ERPNext', HttpStatus.BAD_REQUEST);
          })
        )
      );

      return Buffer.from(response.data);
    } catch (error) {
      throw new HttpException('Terjadi kesalahan saat mengambil PDF', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}