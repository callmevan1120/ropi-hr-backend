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
  // =============================================
  private hitungIsRamadhan(wibDate: Date): boolean {
    const tahun = wibDate.getFullYear();
    const bulan = wibDate.getMonth() + 1;
    const tgl   = wibDate.getDate();
    if (tahun === 2025 && bulan === 3 && tgl >= 1 && tgl <= 30) return true;
    if (tahun === 2026 && bulan === 2 && tgl >= 18) return true;
    if (tahun === 2026 && bulan === 3 && tgl <= 19) return true;
    return false;
  }

  // =============================================
  // HELPER — Bangun nama shift berdasarkan tanggal WIB & branch
  // =============================================
  private buildShiftName(wibDate: Date, branch: string): string {
    const hari         = wibDate.getDay();
    const isFriday     = hari === 5;
    const ramadhan     = this.hitungIsRamadhan(wibDate);
    const branchLabel  = branch.trim().toLowerCase().includes('jakarta') ? 'Jakarta' : 'PH Klaten';
    const hariLabel    = isFriday ? 'Jumat' : 'Senin - Kamis';
    const periodeLabel = ramadhan ? 'Ramadhan' : 'Non Ramadhan';
    return `${hariLabel} (${branchLabel} ${periodeLabel})`;
  }

  // =============================================
  // HELPER — Dapatkan objek tanggal WIB dari server UTC
  // =============================================
  private getWibDate(): Date {
    const now       = new Date();
    const wibString = now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' });
    return new Date(wibString);
  }

  // =============================================
  // HELPER — Format Date ke string YYYY-MM-DD HH:mm:ss
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
  // HELPER — Format Date ke string YYYY-MM-DD saja
  // =============================================
  private formatTanggal(d: Date): string {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // =============================================
  // HELPER — Upsert Shift Assignment untuk hari ini
  //
  // ERPNext butuh Shift Assignment aktif agar Employee Checkin
  // tidak jadi "Off Shift". Fungsi ini otomatis buat assignment
  // yang tepat (Jumat vs Senin-Kamis) setiap hari, hanya 1 hari
  // (start_date = end_date = hari ini) agar tidak override hari lain.
  // =============================================
  private async upsertShiftAssignment(
    employeeId: string,
    namaShift: string,
    tanggalStr: string,
    erpUrl: string,
    authHeader: string,
  ): Promise<void> {
    try {
      // 1. Cari Shift Assignment aktif untuk employee + tanggal hari ini
      const cariRes = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Assignment`, {
          headers: { Authorization: authHeader },
          params: {
            filters: JSON.stringify([
              ['employee',   '=',  employeeId],
              ['start_date', '<=', tanggalStr],
              ['docstatus',  '=',  1],
            ]),
            fields: JSON.stringify(['name', 'shift_type', 'start_date', 'end_date']),
            limit_page_length: 10,
          },
        }),
      );

      const assignments: any[] = cariRes.data.data || [];

      // Filter: hanya yang masih aktif hari ini
      const aktif = assignments.filter(
        (a) => !a.end_date || a.end_date >= tanggalStr,
      );

      // 2. Kalau sudah ada assignment dengan shift yang sama → skip
      const sudahAda = aktif.find((a) => a.shift_type === namaShift);
      if (sudahAda) {
        console.log(`[ShiftAssignment] Sudah ada & benar: ${namaShift} untuk ${employeeId}`);
        return;
      }

      // 3. Cancel semua assignment lama yang konflik
      for (const a of aktif) {
        try {
          await firstValueFrom(
            this.httpService.post(
              `${erpUrl}/api/resource/Shift Assignment/${a.name}/cancel`,
              {},
              { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
            ),
          );
          console.log(`[ShiftAssignment] Cancelled lama: ${a.name} (${a.shift_type})`);
        } catch (e) {
          console.warn(`[ShiftAssignment] Gagal cancel ${a.name}:`, e.message);
        }
      }

      // 4. Buat Shift Assignment baru, hanya berlaku 1 hari ini
      const buatRes = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Shift Assignment`,
          {
            employee:   employeeId,
            shift_type: namaShift,
            start_date: tanggalStr,
            end_date:   tanggalStr, // hanya berlaku hari ini saja
            company:    'PT. Juara Roti Indonesia',
          },
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ),
      );

      const docName = buatRes.data.data?.name;

      // 5. Submit agar ERPNext kenali sebagai assignment aktif
      if (docName) {
        await firstValueFrom(
          this.httpService.post(
            `${erpUrl}/api/resource/Shift Assignment/${docName}/submit`,
            {},
            { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
          ),
        );
        console.log(`[ShiftAssignment] Buat & submit OK: ${namaShift} untuk ${employeeId} tgl ${tanggalStr}`);
      }
    } catch (error: any) {
      // Error shift assignment TIDAK boleh hentikan proses checkin
      console.error('[ShiftAssignment] Gagal upsert:', error.response?.data || error.message);
    }
  }

  // =============================================
  // LOGIN
  // =============================================
  async login(email: string, pass: string) {
    const globalPassword = this.configService.get<string>('GLOBAL_PASSWORD') || 'rahasia123';

    if (pass !== globalPassword) {
      throw new UnauthorizedException('Password yang kamu masukkan salah!');
    }

    const erpUrl    = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey    = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Employee`, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
          params: {
            fields: JSON.stringify([
              'name', 'employee_name', 'company_email', 'personal_email',
              'designation', 'department', 'branch', 'cell_number',
            ]),
            limit_page_length: 1000,
          },
        }),
      );

      const employees = response.data.data;
      const employee  = employees.find(
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
      throw new HttpException('Gagal terhubung ke database HR.', HttpStatus.INTERNAL_SERVER_ERROR);
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
    shiftFromFrontend?: string,
  ) {
    const erpUrl     = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey     = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret  = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';
    const authHeader = `token ${apiKey}:${apiSecret}`;

    const wibDate    = this.getWibDate();
    const waktuStr   = this.formatWaktu(wibDate);
    const tanggalStr = this.formatTanggal(wibDate);
    const hariIni    = wibDate.getDay();

    const isHariKerja   = hariIni >= 1 && hariIni <= 5;
    const branchNorm    = (branch || '').trim().toLowerCase();
    const isBranchValid =
      branchNorm.includes('klaten') ||
      branchNorm.includes('ph')     ||
      branchNorm.includes('jakarta');

    let namaShift: string | null = null;

    if (isHariKerja && isBranchValid) {
      namaShift = shiftFromFrontend?.trim() || this.buildShiftName(wibDate, branch);

      // Hanya saat MASUK: pastikan Shift Assignment hari ini sudah benar
      // agar ERPNext tidak marking sebagai "Off Shift"
      if (tipe === 'MASUK') {
        await this.upsertShiftAssignment(employeeId, namaShift, tanggalStr, erpUrl, authHeader);
      }
    }

    const payload: any = {
      employee:  employeeId,
      log_type:  tipe === 'MASUK' ? 'IN' : 'OUT',
      time:      waktuStr,
      device_id: 'RotiRopi-PWA',
      latitude,
      longitude,
      location:  branch,
      ...(namaShift ? { shift: namaShift } : {}),
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${erpUrl}/api/resource/Employee Checkin`,
          payload,
          { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } },
        ),
      );

      return {
        success: true,
        message: namaShift
          ? `Berhasil mencatatkan absen ${namaShift}`
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
    const erpUrl    = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey    = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';

    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${erpUrl}/api/resource/Shift Location/${encodeURIComponent(branchName)}`,
          { headers: { Authorization: `token ${apiKey}:${apiSecret}` } },
        ),
      );

      const shiftLoc = response.data.data;
      return [{
        branch: branchName,
        nama:   branchName,
        lat:    parseFloat(shiftLoc.latitude),
        lng:    parseFloat(shiftLoc.longitude),
        radius: shiftLoc.radius || 150,
      }];
    } catch (error) {
      console.error(`Gagal tarik Shift Location untuk ${branchName}:`, error.message);
      return [];
    }
  }

  // =============================================
  // CEK STATUS ABSEN HARI INI
  // =============================================
  async getAttendanceStatus(employeeId: string) {
    const erpUrl    = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey    = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';

    const wibDate    = this.getWibDate();
    const hariIniWib = this.formatTanggal(wibDate);

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Employee Checkin`, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
          params: {
            filters: JSON.stringify([
              ['employee', '=', employeeId],
              ['time', '>=', `${hariIniWib} 00:00:00`],
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