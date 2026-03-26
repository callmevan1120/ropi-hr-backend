import { Controller, Get, Param } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Controller('api/locations')
export class LocationsController {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────
  // TARIK DATA LANGSUNG DARI ERPNEXT (Doctype: Shift Location)
  // ─────────────────────────────────────────────────────────
  private async fetchLocationsFromERP() {
    const erpUrl = this.configService.get<string>('ERPNEXT_URL') ?? '';
    const apiKey = this.configService.get<string>('ERPNEXT_API_KEY') ?? '';
    const apiSecret = this.configService.get<string>('ERPNEXT_API_SECRET') ?? '';

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${erpUrl}/api/resource/Shift Location`, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
          params: {
            fields: JSON.stringify(['name', 'latitude', 'longitude', 'checkin_radius']),
            limit_page_length: 100, // Menarik maksimal 100 lokasi outlet/kantor
          },
        })
      );

      // Memetakan data dari ERPNext ke format yang dibutuhkan aplikasi (Frontend)
      return response.data.data.map((loc: any) => ({
        nama: loc.name,
        lat: Number(loc.latitude) || 0,
        lng: Number(loc.longitude) || 0,
        radius: Number(loc.checkin_radius) || 100,
      }));
    } catch (error) {
      console.error('Gagal mengambil Shift Location dari ERPNext:', error);
      return [];
    }
  }

  @Get()
  async getAllLocations() {
    const locations = await this.fetchLocationsFromERP();
    return { success: true, locations };
  }

  @Get(':branch')
  async getLocationByBranch(@Param('branch') branch: string) {
    const locations = await this.fetchLocationsFromERP();
    
    // Cari lokasi yang namanya mengandung kata kunci branch
    const filtered = locations.filter((loc: any) => 
      loc.nama.toLowerCase().includes(branch.toLowerCase())
    );

    if (filtered.length > 0) {
      return { success: true, locations: filtered };
    }
    
    // Fallback: Jika tidak ketemu spesifik, kembalikan semua
    return { success: true, locations };
  }
}