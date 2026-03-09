import { Controller, Post, Body, Get, Query } from '@nestjs/common';
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

  // ✨ ENDPOINT RIWAYAT IZIN ✨
  @Get('leave-history')
  async getLeaveHistory(@Query('employee_id') employeeId: string) {
    return this.attendanceService.getLeaveHistory(employeeId);
  }
}