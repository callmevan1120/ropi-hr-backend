import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { AttendanceController } from './attendance/attendance.controller';
import { AttendanceService } from './attendance/attendance.service';
import { LocationsModule } from './locations/locations.module';
import { LeavesModule } from './leaves/leaves.module';
import { NotificationsModule } from './notifications/notifications.module'; 

// IMPORT UNTUK RATE LIMITER (ANTI-SPAM)
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'frontend', 'public'),
    }),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    
    // KONFIGURASI RATE LIMITER
    // Membatasi 1 user/IP maksimal 30 request per 1 menit (60000 ms)
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 30,
    }]),

    AuthModule,
    HttpModule,
    LocationsModule,
    LeavesModule,
    NotificationsModule,
  ],
  controllers: [AppController, AttendanceController],
  providers: [
    AppService, 
    AttendanceService,
    // MENGAKTIFKAN PENJAGAAN (GUARD) KE SELURUH API
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    }
  ],
})
export class AppModule {}