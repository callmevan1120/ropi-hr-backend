import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AttendanceService } from './attendance.service';
import { AttendanceController } from './attendance.controller';

@Module({
  imports: [HttpModule], // Wajib ada
  controllers: [AttendanceController],
  providers: [AttendanceService]
})
export class AttendanceModule {}