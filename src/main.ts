import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json, urlencoded } from 'express'; // <-- REVISI: Tambahkan urlencoded

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Aktifkan CORS biar PWA bisa komunikasi dengan backend ini
  app.enableCors({
    origin: '*',  // izinkan semua origin saat development
  }); 

  // <-- REVISI WAJIB: Perbesar limit ke 50mb (karena Base64 bikin ukuran file bengkak)
  app.use(json({ limit: '50mb' })); 
  app.use(urlencoded({ extended: true, limit: '50mb' })); // <-- Tambahan wajib
  
  // Paksa jalan di port 3333
  await app.listen(3333);
  console.log(`🚀 Backend RopiHR berhasil jalan di Port 3333`);
}

bootstrap();