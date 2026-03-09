import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

@Module({
  imports: [HttpModule], // Wajib ditambahkan untuk memanggil API eksternal
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}