import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { LeavesService } from './leaves.service';

@Controller('api/leaves')
export class LeavesController {
  constructor(private readonly leavesService: LeavesService) {}

  // Endpoint: GET /api/leaves?employee_id=...
  @Get()
  async getLeaves(@Query('employee_id') employee_id: string) {
    return this.leavesService.getLeaveInfo(employee_id);
  }

  // Endpoint: POST /api/leaves
  @Post()
  async applyLeave(@Body() body: any) {
    return this.leavesService.createLeaveApplication(body);
  }
}