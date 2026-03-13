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
            // PASTIKAN designation ADA DI SINI
            fields: JSON.stringify(['name', 'employee_name', 'company_email', 'personal_email', 'designation', 'department', 'branch', 'cell_number']),
            limit_page_length: 1000,
          },
        }),
      );

      const employees = response.data.data;
      
      // Cari employee berdasarkan company_email atau personal_email
      const employee = employees.find((emp) => 
        emp.company_email === email || emp.personal_email === email
      );

      if (!employee) {
        throw new UnauthorizedException(`Email ${email} belum terdaftar di ERPNext. Hubungi HR!`);
      }

      return {
        statusCode: 200,
        message: 'Login Berhasil',
        data: {
          employee_id:  employee.name,
          name:         employee.employee_name,
          email:        employee.company_email || employee.personal_email || '',
          role:         employee.designation, // Mengirimkan Designation ke Frontend
          department:   employee.department,
          branch:       employee.branch, 
          phone:        employee.cell_number,
        },
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new HttpException('Gagal terhubung ke database HR.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // =============================================
  // ABSEN — Bypass Kantor & Natural Outlet
  // =============================================
  async absen(employeeId: string, tipe: 'MASUK' | 'KELUAR', latitude: number, longitude: number, branch: string) {
    const erpUrl    = this.configService.get<string>('ERPNEXT_URL');
    const apiKey    = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');

    // FIX ZONA WAKTU: Pastikan Server Vercel Menggunakan Waktu WIB (Asia/Jakarta) 
    const now = new Date();
    const wibString = now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' });
    const wibDate = new Date(wibString);

    const hariIni = wibDate.getDay(); // 0 = Minggu, 1 = Senin, ..., 5 = Jumat, 6 = Sabtu

    // Format waktu manual YYYY-MM-DD HH:mm:ss sesuai standar ERPNext
    const yyyy = wibDate.getFullYear();
    const mm = String(wibDate.getMonth() + 1).padStart(2, '0');
    const dd = String(wibDate.getDate()).padStart(2, '0');
    const hh = String(wibDate.getHours()).padStart(2, '0');
    const min = String(wibDate.getMinutes()).padStart(2, '0');
    const ss = String(wibDate.getSeconds()).padStart(2, '0');
    const waktuStr = `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;

    const isRamadhan = wibDate <= new Date('2026-03-20T23:59:59');
    const suffix = isRamadhan ? 'Ramadhan' : 'Non Ramadhan';

    let payload: any = {
      employee:  employeeId,
      log_type:  tipe === 'MASUK' ? 'IN' : 'OUT',
      time:      waktuStr,
      device_id: 'RotiRopi-PWA',
      latitude,
      longitude,
      location:  branch, 
    };

    // LOGIKA INJEKSI SHIFT 
    if (branch === 'PH Klaten' || branch === 'Jakarta') {
      const lokasiStr = branch; 
      let namaShift = '';
      
      // Jika hariIni adalah 5 (Jumat WIB)
      if (hariIni === 5) {
        namaShift = `Jumat (${lokasiStr} ${suffix})`;
      } else {
        namaShift = `Senin - Kamis (${lokasiStr} ${suffix})`;
      }
      
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
        message: payload.shift ? `Berhasil mencatatkan absen ${payload.shift}` : `Berhasil mencatatkan absen.`,
        data: response.data.data,
      };
    } catch (error: any) {
      console.error('Error absen:', error.response?.data || error.message);
      throw new HttpException(error.response?.data?.message || 'Gagal mencatat absen.', HttpStatus.INTERNAL_SERVER_ERROR);
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
        this.httpService.get(`${erpUrl}/api/resource/Shift Location/${encodeURIComponent(branchName)}`, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
        }),
      );

      const shiftLoc = response.data.data;

      return [{
        branch: branchName,
        nama: branchName,
        lat: parseFloat(shiftLoc.latitude),
        lng: parseFloat(shiftLoc.longitude),
        radius: shiftLoc.radius || 150 
      }];
    } catch (error) {
      console.error(`Gagal tarik Shift Location untuk ${branchName}:`, error.message);
      return []; 
    }
  }

  // =============================================
  // CEK STATUS ABSEN
  // =============================================
  async getAttendanceStatus(employeeId: string) {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL');
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');

    // Pastikan pengecekan hari ini juga menggunakan WIB
    const now = new Date();
    const wibString = now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' });
    const wibDate = new Date(wibString);
    const yyyy = wibDate.getFullYear();
    const mm = String(wibDate.getMonth() + 1).padStart(2, '0');
    const dd = String(wibDate.getDate()).padStart(2, '0');
    const hariIniWib = `${yyyy}-${mm}-${dd}`;

    try {
        const response = await firstValueFrom(
            this.httpService.get(`${erpUrl}/api/resource/Employee Checkin`, {
                headers: { Authorization: `token ${apiKey}:${apiSecret}` },
                params: {
                    filters: JSON.stringify([
                        ['employee', '=', employeeId],
                        ['time', '>=', `${hariIniWib} 00:00:00`],
                    ]),
                    fields: JSON.stringify(['log_type']),
                    order_by: 'time desc',
                    limit_page_length: 1
                },
            }),
        );

        const lastLog = response.data.data[0];
        return { 
            status: lastLog ? lastLog.log_type : 'OUT',
            next_action: lastLog?.log_type === 'IN' ? 'KELUAR' : 'MASUK'
        };
    } catch (error) {
        return { status: 'OUT', next_action: 'MASUK' };
    }
  }
}