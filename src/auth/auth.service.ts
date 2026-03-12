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
  // LOGIN (Mencari berdasarkan Employee ID)
  // =============================================
  async login(identifier: string, pass: string) {
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
            // Ambil designation untuk cek HR
            fields: JSON.stringify(['name', 'employee_name', 'company_email', 'personal_email', 'designation', 'department', 'branch', 'cell_number']),
            limit_page_length: 1000,
          },
        }),
      );

      const employees = response.data.data;
      
      // Cari employee berdasarkan ID (name), email, atau personal email.
      const employee = employees.find((emp) => 
        emp.name === identifier || 
        emp.company_email === identifier || 
        emp.personal_email === identifier
      );

      if (!employee) {
        throw new UnauthorizedException(`ID atau Email ${identifier} belum terdaftar di ERPNext. Hubungi HR!`);
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
  // ABSEN — REVISI FINAL: Bypass Kantor & Natural Outlet
  // =============================================
  async absen(employeeId: string, tipe: 'MASUK' | 'KELUAR', latitude: number, longitude: number, branch: string) {
    const erpUrl    = this.configService.get<string>('ERPNEXT_URL');
    const apiKey    = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');

    const now = new Date();
    const hariIni = now.getDay(); 
    const waktuStr = now.toISOString().replace('T', ' ').substring(0, 19);

    const isRamadhan = now <= new Date('2026-03-20');
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

    if (branch === 'PH Klaten' || branch === 'Jakarta') {
      const lokasiStr = branch; 
      let namaShift = '';
      
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
    } catch (error) {
      console.error('Error absen:', error.response?.data || error.message);
      throw new HttpException(error.response?.data?.message || 'Gagal mencatat absen.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // =============================================
  // GET LOKASI — REVISI: Tarik dari DocType "Shift Location"
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

    const hariIni = new Date().toISOString().split('T')[0];

    try {
        const response = await firstValueFrom(
            this.httpService.get(`${erpUrl}/api/resource/Employee Checkin`, {
                headers: { Authorization: `token ${apiKey}:${apiSecret}` },
                params: {
                    filters: JSON.stringify([
                        ['employee', '=', employeeId],
                        ['time', '>=', `${hariIni} 00:00:00`],
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