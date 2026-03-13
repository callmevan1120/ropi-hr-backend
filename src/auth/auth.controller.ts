import { Controller, Post, Get, Body, Param, HttpException, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';

function hitungJarak(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

@Controller('api')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── POST /api/auth/login ───────────────────
  @Post('auth/login')
  async login(@Body() body: any) {
    const identifier = body.employeeId || body.email;
    return this.authService.login(identifier, body.password);
  }

  // ─── GET /api/locations/:branch ─────────────
  @Get('locations/:branch')
  async getLokasiByBranch(@Param('branch') branch: string) {
    const lokasi = await this.authService.getLokasi(branch);
    return { success: true, locations: lokasi };
  }

  // ─── POST /api/attendance/checkin ───────────
  @Post('attendance/checkin')
  async checkin(@Body() body: any) {
    // FIX: ambil juga field 'shift' dari body yang dikirim frontend
    const { employee_id, tipe, latitude, longitude, branch, shift } = body;

    if (!employee_id || !tipe || latitude === undefined || longitude === undefined || !branch) {
      throw new HttpException(
        'Data tidak lengkap. Butuh: employee_id, tipe, latitude, longitude, dan branch',
        HttpStatus.BAD_REQUEST,
      );
    }

    const lokasiKantor = await this.authService.getLokasi(branch);

    if (!lokasiKantor || lokasiKantor.length === 0) {
      throw new HttpException(
        `Lokasi 'Shift Location' untuk cabang '${branch}' belum didaftarkan di ERPNext. Hubungi Admin HR!`,
        HttpStatus.BAD_REQUEST,
      );
    }

    let lokasiValid = false;
    let lokasiTerdekat = { nama: '', jarak: Infinity, radius: 0 };

    for (const lokasi of lokasiKantor) {
      const jarak = Math.round(hitungJarak(latitude, longitude, lokasi.lat, lokasi.lng));

      if (jarak < lokasiTerdekat.jarak) {
        lokasiTerdekat = { nama: lokasi.nama, jarak, radius: lokasi.radius };
      }

      if (jarak <= lokasi.radius) {
        lokasiValid = true;
        break;
      }
    }

    if (!lokasiValid) {
      throw new HttpException(
        `Lokasi tidak sesuai! Kamu berada ${lokasiTerdekat.jarak}m dari titik absen ${lokasiTerdekat.nama}. Batas maksimal radius: ${lokasiTerdekat.radius}m.`,
        HttpStatus.FORBIDDEN,
      );
    }

    // FIX: teruskan 'shift' dari frontend ke authService.absen()
    return this.authService.absen(employee_id, tipe, latitude, longitude, branch, shift);
  }
}