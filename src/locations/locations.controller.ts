import { Controller, Get, Param } from '@nestjs/common';

// Data langsung ditempel di sini, jadi nggak perlu baca-baca file json lagi!
const dataLokasi = [
  { branch: "Kantor Pusat", nama: "PH Klaten", lat: -7.6150, lng: 110.6870, radius: 100 },
  { branch: "Kantor Cabang 2", nama: "Kantor Cabang Semarang Barat", lat: -6.9824, lng: 110.3900, radius: 100 },
  { branch: "Outlet Banyumanik", nama: "Outlet Banyumanik", lat: -7.0734, lng: 110.4180, radius: 80 }
];

@Controller('api/locations')
export class LocationsController {
  
  @Get()
  getAllLocations() {
    return { success: true, locations: dataLokasi };
  }

  @Get(':branch')
  getLocationByBranch(@Param('branch') branch: string) {
    const filtered = dataLokasi.filter(loc => loc.branch === branch);
    if (filtered.length > 0) {
      return { success: true, locations: filtered };
    }
    return { success: true, locations: dataLokasi };
  }
}