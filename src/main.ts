import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Aktifkan CORS biar PWA bisa komunikasi dengan backend ini
  app.enableCors({
    origin: '*',  // izinkan semua origin saat development
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', // Tambahan aman buat Vercel
    credentials: true,
  }); 

  // Perbesar limit ke 50mb (karena Base64 bikin ukuran file bengkak)
  app.use(json({ limit: '50mb' })); 
  app.use(urlencoded({ extended: true, limit: '50mb' }));
  
  // REVISI WAJIB VERCEL: Jangan paksa 3333, biarkan Vercel yang atur port-nya
  const port = process.env.PORT || 3333;
  await app.listen(port);
  console.log(`🚀 Backend RopiHR berhasil jalan di Port ${port}`);
}

bootstrap();