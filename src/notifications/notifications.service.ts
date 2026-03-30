import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Auth header
  // ─────────────────────────────────────────────────────────────────
  private getAuth() {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL');
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY');
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET');
    return { erpUrl, headers: { Authorization: `token ${apiKey}:${apiSecret}` } };
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Mengubah jam (HH:mm:ss) menjadi total menit untuk perbandingan
  // ─────────────────────────────────────────────────────────────────
  private toMenit(jamStr: string): number {
    if (!jamStr || jamStr === '-') return 0;
    const [h, m] = jamStr.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPER: Format durasi telat agar rapi (misal "1j 15m")
  // ─────────────────────────────────────────────────────────────────
  private formatDurasi(totalMenit: number): string {
    if (totalMenit < 60) return `${totalMenit}m`;
    const jam = Math.floor(totalMenit / 60);
    const sisaMenit = totalMenit % 60;
    return sisaMenit > 0 ? `${jam}j ${sisaMenit}m` : `${jam}j`;
  }

  // ─────────────────────────────────────────────────────────────────
  // MAIN FUNCTION: Ambil Notifikasi
  // ─────────────────────────────────────────────────────────────────
  async getNotifications(employeeId: string) {
    const { erpUrl, headers } = this.getAuth();

    try {
      // 1. AMBIL DATA SHIFT MASTER
      // Kita perlu tahu batas jam masuk untuk tiap shift agar deteksi telat akurat
      let masterShifts: Record<string, string> = {};
      try {
        const shiftRes = await firstValueFrom(
          this.httpService.get(`${erpUrl}/api/resource/Shift Type`, {
            headers,
            params: {
              fields: JSON.stringify(['name', 'start_time']),
              limit_page_length: 100
            }
          })
        );
        const shiftData = shiftRes.data.data || [];
        shiftData.forEach((s: any) => {
          // Menyimpan batas masuk. Contoh: 'Shift Pagi Outlet': '06:00'
          if (s.start_time) masterShifts[s.name] = s.start_time.substring(0, 5);
        });
      } catch (err) {
        console.warn('Gagal ambil master shift untuk notifikasi');
      }

      // 2. AMBIL RIWAYAT CUTI / IZIN (5 Terakhir)
      let leaveNotifs: any[] = [];
      try {
        const leaveRes = await firstValueFrom(
          this.httpService.get(`${erpUrl}/api/resource/Leave Application`, {
            headers,
            params: {
              filters: JSON.stringify([['employee', '=', employeeId]]),
              fields: JSON.stringify(['name', 'leave_type', 'status', 'modified', 'from_date']),
              order_by: 'modified desc',
              limit_page_length: 5,
              _t: Date.now() // Bust Cache Vercel
            }
          })
        );

        leaveNotifs = (leaveRes.data.data || []).map(l => ({
          id: l.name,
          title: `Status ${l.leave_type}`,
          message: l.status === 'Approved' ? `Hore! Pengajuan ${l.leave_type} kamu disetujui HRD.` : 
                   l.status === 'Rejected' ? `Maaf, pengajuan ${l.leave_type} kamu ditolak.` :
                   `Pengajuan ${l.leave_type} sedang diproses.`,
          time: l.modified,
          type: l.status === 'Approved' ? 'success' : l.status === 'Rejected' ? 'error' : 'info'
        }));
      } catch (err) {
        console.warn('Gagal ambil riwayat izin untuk notifikasi');
      }

      // 3. AMBIL RIWAYAT ABSEN MASUK (Bulan Ini untuk Hitung Akumulasi Telat)
      let lateNotifs: any[] = [];
      try {
        const d = new Date();
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        // Filter dari tanggal 1 bulan ini
        const startOfMonth = `${yyyy}-${mm}-01 00:00:00`;

        const attendRes = await firstValueFrom(
          this.httpService.get(`${erpUrl}/api/resource/Employee Checkin`, {
            headers,
            params: {
              filters: JSON.stringify([
                ['employee', '=', employeeId],
                ['log_type', '=', 'IN'],
                ['time', '>=', startOfMonth]
              ]),
              fields: JSON.stringify(['name', 'time', 'shift', 'creation']),
              order_by: 'time asc', // ASCENDING: Urutkan dari awal bulan ke hari ini
              limit_page_length: 100, // Cukup untuk 1 bulan
              _t: Date.now() // Bust Cache Vercel
            }
          })
        );

        let telatCount = 0;
        const rawAttendances = attendRes.data.data || [];

        // Loop dari absen pertama di bulan ini sampai terbaru
        rawAttendances.forEach((a: any) => {
          const jamAktual = a.time.split(' ')[1].substring(0, 5); // Misal '07:45'
          const tglAbsen = a.time.split(' ')[0];
          
          let jamBatas = '07:30'; // Default fallback

          if (a.shift && masterShifts[a.shift]) {
            jamBatas = masterShifts[a.shift];
          } else if (a.shift && a.shift.toLowerCase().includes('satpam')) {
            jamBatas = '07:00'; 
          }

          const selisihMenit = this.toMenit(jamAktual) - this.toMenit(jamBatas);

          if (selisihMenit > 0) {
            telatCount++; // Tambah angka keterlambatan bulan ini
            
            lateNotifs.push({
              id: `db-late-${a.name}`,
              title: 'Absen Terlambat',
              message: `Waduh, kamu tercatat telat ${this.formatDurasi(selisihMenit)} pada tanggal ${tglAbsen}. (Ini keterlambatan ke-${telatCount} kamu di bulan ini)`,
              time: a.creation,
              type: 'error'
            });
          }
        });

        // Karena kita menggunakan ASCENDING, data terbaru ada di akhir array.
        // Kita potong 5 terakhir saja, lalu dibalik (reverse) agar yang paling baru tampil di atas.
        lateNotifs = lateNotifs.slice(-5).reverse();

      } catch (err) {
        console.warn('Gagal ambil riwayat absen untuk notifikasi');
      }

      // 4. GABUNGKAN DAN URUTKAN (Izin + Telat)
      const allNotifs = [...leaveNotifs, ...lateNotifs];
      
      // Urutkan berdasarkan waktu notifikasi (terbaru di atas)
      allNotifs.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

      return {
        success: true,
        data: allNotifs
      };

    } catch (error: any) {
      console.error('Gagal mengambil notifikasi:', error.response?.data || error.message);
      return { success: false, data: [] };
    }
  }
}