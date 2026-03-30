import { Controller, Post, Body, Get, Query, Res, HttpStatus, Delete, Param } from '@nestjs/common';
import { AttendanceService } from './attendance.service';

@Controller('api/attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Post('checkin')
  async checkin(@Body() body: any) {
    return this.attendanceService.createCheckin(body);
  }

  @Get()
  async getHistory(
    @Query('employee_id') employee_id: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.attendanceService.getHistory(employee_id, from, to);
  }

  @Get('all-history')
  async getAllHistory(
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.attendanceService.getAllHistory(from, to);
  }

  @Get('shifts')
  async getShifts() {
    return this.attendanceService.getShifts();
  }

  @Get('leave-types')
  async getLeaveTypes() {
    return this.attendanceService.getLeaveTypes();
  }

  @Post('leave-request')
  async submitLeaveRequest(@Body() body: any) {
    return this.attendanceService.submitLeaveRequest(body);
  }

  @Delete('leave-request/:id')
  async cancelLeaveRequest(@Param('id') id: string) {
    return this.attendanceService.cancelLeaveRequest(id);
  }

  @Get('leave-history')
  async getLeaveHistory(@Query('employee_id') employeeId: string) {
    return this.attendanceService.getLeaveHistory(employeeId);
  }

  // Tarik SEMUA izin / cuti sekaligus untuk optimasi HR Dashboard
  @Get('all-leave-requests')
  async getAllLeaveRequests() {
    return this.attendanceService.getAllLeaveRequests();
  }

  @Get('active-shift')
  async getActiveShift(@Query('employee_id') employeeId: string) {
    return this.attendanceService.getActiveShift(employeeId);
  }

  @Get('hr-users')
  async getHrUsers() {
    return this.attendanceService.getHrUsers();
  }

  @Post('shift-request')
  async submitShiftRequest(@Body() body: any) {
    return this.attendanceService.submitShiftRequest(body);
  }

  @Get('shift-history')
  async getShiftHistory(@Query('employee_id') employeeId: string) {
    return this.attendanceService.getShiftHistory(employeeId);
  }

  @Get('file')
  async getFile(@Query('path') filePath: string, @Res() res: any) {
    try {
      if (!filePath || !filePath.startsWith('/files/')) {
        return res.status(400).json({ error: 'Invalid path' });
      }
      const { buffer, contentType } = await this.attendanceService.proxyFile(filePath);
      res.set('Content-Type', contentType);
      res.send(buffer);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch file' });
    }
  }
}