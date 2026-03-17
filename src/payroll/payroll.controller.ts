import { Controller, Get, Query, Res, HttpException, HttpStatus } from '@nestjs/common';
import { PayrollService } from './payroll.service';
// import { Response } from 'express'; <-- Hapus atau comment baris ini

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

  // 👇 Ubah Response menjadi any 👇
  @Get('download')
  async downloadSlip(@Query('slip_id') slipId: string, @Res() res: any) {
    if (!slipId) {
      throw new HttpException('slip_id wajib diisi', HttpStatus.BAD_REQUEST);
    }

    try {
      const pdfBuffer = await this.payrollService.downloadSlipPdf(slipId);
      
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="Slip_Gaji_${slipId}.pdf"`,
        'Content-Length': pdfBuffer.length,
      });

      res.send(pdfBuffer);
    } catch (error) {
      throw new HttpException('Gagal memproses file PDF', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}