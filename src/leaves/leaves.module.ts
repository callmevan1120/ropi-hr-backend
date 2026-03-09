import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { LeavesController } from './leaves.controller';
import { LeavesService } from './leaves.service';

@Module({
  imports: [HttpModule],
  controllers: [LeavesController],
  providers: [LeavesService],
})
export class LeavesModule {}