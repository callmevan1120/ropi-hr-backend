import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios'; 
import { ServeStaticModule } from '@nestjs/serve-static'; // Import Baru
import { join } from 'path'; // Import Baru
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { AttendanceController } from './attendance/attendance.controller'; 
import { AttendanceService } from './attendance/attendance.service';
import { LocationsModule } from './locations/locations.module';
import { LeavesModule } from './leaves/leaves.module';

@Module({
  imports: [
    // 👇 KONFIGURASI UNTUK MENAMPILKAN HTML DARI FOLDER FRONTEND/PUBLIC 👇
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'frontend', 'public'), 
    }),
    
    ConfigModule.forRoot({
      isGlobal: true, 
    }),
    AuthModule,
    HttpModule,
    LocationsModule, 
    LeavesModule,
  ],
  controllers: [AppController, AttendanceController],
  providers: [AppService, AttendanceService],
})
export class AppModule {}