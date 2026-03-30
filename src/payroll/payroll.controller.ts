import { Controller, Get, Query, Res, HttpException, HttpStatus } from '@nestjs/common';
import { PayrollService } from './payroll.service';
// import { Response } from 'express'; <-- Tetap dihapus/dicomment sesuai gaya kodemu

@Controller('api/payroll')
export class PayrollController {
  constructor(private readonly payrollService: PayrollService) {}

  @Get('slips')
  async getSlips(@Query('employee_id') employeeId: string) {
    if (!employeeId) {
      throw new HttpException('employee_id wajib diisi', HttpStatus.BAD_REQUEST);
    }
    return this.payrollService.getSlips(employeeId);
  }

  // Menggunakan res: any sesuai keinginanmu
  @Get('download')
  async downloadSlip(@Query('slip_id') slipId: string, @Res() res: any) {
    if (!slipId) {
      throw new HttpException('slip_id wajib diisi', HttpStatus.BAD_REQUEST);
    }

    try {
      // Sekarang kita memanggil fungsi stream, bukan fungsi buffer
      const pdfStream = await this.payrollService.streamSlipPdf(slipId);
      
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="Slip_Gaji_${slipId}.pdf"`,
      });

      // Mengalirkan (pipe) data langsung dari ERPNext ke klien
      pdfStream.pipe(res);
    } catch (error) {
      console.error('Download Slip Error:', error);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
        success: false,
        message: 'Gagal memproses file PDF dari sistem.'
      });
    }
  }
}