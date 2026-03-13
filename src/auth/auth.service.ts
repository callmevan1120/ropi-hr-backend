import { Injectable, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class AuthService {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  // =============================================
  // HELPER — Cek apakah tanggal WIB masuk Ramadhan
  // Logika ini HARUS identik dengan Absen.tsx (isRamadhan)
  // =============================================
  private hitungIsRamadhan(wibDate: Date): boolean {
    const tahun = wibDate.getFullYear();
    const bulan = wibDate.getMonth() + 1; // 1-indexed
    const tgl   = wibDate.getDate();

    // Ramadhan 2025: 1 - 30 Maret 2025
    if (tahun === 2025 && bulan === 3 && tgl >= 1 && tgl <= 30) return true;

    // Ramadhan 2026: 18 Februari - 19 Maret 2026
    if (tahun === 2026 && bulan === 2 && tgl >= 18) return true;
    if (tahun === 2026 && bulan === 3 && tgl <= 19) return true;

    return false;
  }

  // =============================================
  // HELPER — Bangun nama shift berdasarkan tanggal WIB & branch
  // Logika ini HARUS identik dengan getShiftKantor() di Absen.tsx
  // =============================================
  private buildShiftName(wibDate: Date, branch: string): string {
    const hari     = wibDate.getDay(); // 0 = Min, 5 = Jum
    const isFriday = hari === 5;
    const ramadhan = this.hitungIsRamadhan(wibDate);

    // Normalkan branch agar toleran terhadap variasi spasi/huruf
    const branchNorm = branch.trim();
    const branchLabel = branchNorm.toLowerCase().includes('jakarta') ? 'Jakarta' : 'PH Klaten';
    const hariLabel   = isFriday ? 'Jumat' : 'Senin - Kamis';
    const periodeLabel = ramadhan ? 'Ramadhan' : 'Non Ramadhan';

    return `${hariLabel} (${branchLabel} ${periodeLabel})`;
  }

  // =============================================
  // HELPER — Dapatkan objek tanggal WIB dari Date UTC server
  // =============================================
  private getWibDate(): Date {
    const now       = new Date();
    const wibString = now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' });
    return new Date(wibString);
  }

  // =============================================
  // HELPER — Format tanggal ke string YYYY-MM-DD HH:mm:ss
  // =============================================
  private formatWaktu(d: Date): string {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    const hh   = String(d.getHours()).padStart(2, '0');
    const min  = String(d.getMinutes()).padStart(2, '0');
    const ss   = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  }

  // =============================================
  // LOGIN (Mencari berdasarkan Email)
  // =============================================
  async login(email: string, pass: string) {
    const globalPassword = this.configService.get<string>('GLOBAL_PASSWORD') || 'rahasia123';

    if (pass !== globalPassword) {
      throw new UnauthorizedException('Password yang kamu masukkan salah!');
    }

    const erpUrl    = this.configService.get<string>('ERPNEXT_URL');
    const apiKey    = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Employee`, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
          params: {
            fields: JSON.stringify([
              'name',
              'employee_name',
              'company_email',
              'personal_email',
              'designation',
              'department',
              'branch',
              'cell_number',
            ]),
            limit_page_length: 1000,
          },
        }),
      );

      const employees = response.data.data;

      // Cari employee berdasarkan company_email atau personal_email
      const employee = employees.find(
        (emp) => emp.company_email === email || emp.personal_email === email,
      );

      if (!employee) {
        throw new UnauthorizedException(
          `Email ${email} belum terdaftar di ERPNext. Hubungi HR!`,
        );
      }

      return {
        statusCode: 200,
        message: 'Login Berhasil',
        data: {
          employee_id: employee.name,
          name:        employee.employee_name,
          email:       employee.company_email || employee.personal_email || '',
          role:        employee.designation,
          department:  employee.department,
          branch:      employee.branch,
          phone:       employee.cell_number,
        },
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new HttpException(
        'Gagal terhubung ke database HR.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // =============================================
  // ABSEN — Checkin / Checkout ke ERPNext
  // =============================================
  async absen(
    employeeId: string,
    tipe: 'MASUK' | 'KELUAR',
    latitude: number,
    longitude: number,
    branch: string,
    // FIX: terima shift dari frontend jika sudah dihitung di sana
    shiftFromFrontend?: string,
  ) {
    const erpUrl    = this.configService.get<string>('ERPNEXT_URL');
    const apiKey    = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');

    const wibDate  = this.getWibDate();
    const waktuStr = this.formatWaktu(wibDate);
    const hariIni  = wibDate.getDay(); // 0 = Min, 6 = Sab

    let payload: any = {
      employee:  employeeId,
      log_type:  tipe === 'MASUK' ? 'IN' : 'OUT',
      time:      waktuStr,
      device_id: 'RotiRopi-PWA',
      latitude,
      longitude,
      location:  branch,
    };

    // ── FIX 1: Hanya inject shift di hari kerja (Senin–Jumat)
    // Weekend tidak perlu shift injection
    const isHariKerja = hariIni >= 1 && hariIni <= 5;

    // ── FIX 2: Normalkan branch dengan includes() agar toleran variasi string
    const branchNorm  = (branch || '').trim().toLowerCase();
    const isBranchValid =
      branchNorm.includes('klaten') ||
      branchNorm.includes('ph')     ||
      branchNorm.includes('jakarta');

    if (isHariKerja && isBranchValid) {
      // ── FIX 3: Prioritaskan shift dari frontend (sudah dihitung dengan masterShifts)
      // Fallback ke hitungan backend jika frontend tidak kirim shift
      const namaShift = shiftFromFrontend?.trim() || this.buildShiftName(wibDate, branch);
      payload.shift = namaShift;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Employee Checkin`,
          payload,
          {
            headers: {
              Authorization: `token ${apiKey}:${apiSecret}`,
              'Content-Type': 'application/json',
            },
          },
        ),
      );

      return {
        success: true,
        message: payload.shift
          ? `Berhasil mencatatkan absen ${payload.shift}`
          : `Berhasil mencatatkan absen.`,
        data: response.data.data,
      };
    } catch (error: any) {
      console.error('Error absen:', error.response?.data || error.message);
      throw new HttpException(
        error.response?.data?.message || 'Gagal mencatat absen.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // =============================================
  // GET LOKASI — Tarik dari DocType "Shift Location"
  // =============================================
  async getLokasi(branchName: string) {
    const erpUrl    = this.configService.get<string>('ERPNEXT_URL');
    const apiKey    = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');

    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Shift Location/${encodeURIComponent(branchName)}`,
          { headers: { Authorization: `token ${apiKey}:${apiSecret}` } },
        ),
      );

      const shiftLoc = response.data.data;

      return [
        {
          branch: branchName,
          nama:   branchName,
          lat:    parseFloat(shiftLoc.latitude),
          lng:    parseFloat(shiftLoc.longitude),
          radius: shiftLoc.radius || 150,
        },
      ];
    } catch (error) {
      console.error(`Gagal tarik Shift Location untuk ${branchName}:`, error.message);
      return [];
    }
  }

  // =============================================
  // CEK STATUS ABSEN HARI INI
  // =============================================
  async getAttendanceStatus(employeeId: string) {
    const erpUrl    = this.configService.get<string>('ERPNEXT_URL');
    const apiKey    = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');

    const wibDate   = this.getWibDate();
    const yyyy      = wibDate.getFullYear();
    const mm        = String(wibDate.getMonth() + 1).padStart(2, '0');
    const dd        = String(wibDate.getDate()).padStart(2, '0');
    const hariIniWib = `${yyyy}-${mm}-${dd}`;

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Employee Checkin`, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
          params: {
            filters: JSON.stringify([
              ['employee', '=', employeeId],
              ['time', '>=', `${hariIniWib} 00:00:00`],
              // FIX: tambahkan upper bound agar tidak terbaca data masa depan
              ['time', '<=', `${hariIniWib} 23:59:59`],
            ]),
            fields: JSON.stringify(['log_type']),
            order_by: 'time desc',
            limit_page_length: 1,
          },
        }),
      );

      const lastLog = response.data.data[0];
      return {
        status:      lastLog ? lastLog.log_type : 'OUT',
        next_action: lastLog?.log_type === 'IN' ? 'KELUAR' : 'MASUK',
      };
    } catch (error) {
      return { status: 'OUT', next_action: 'MASUK' };
    }
  }
}