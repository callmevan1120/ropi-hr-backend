import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { LocationsController } from './locations.controller';

@Module({
  imports: [HttpModule, ConfigModule],
  controllers: [LocationsController]
})
export class LocationsModule {}