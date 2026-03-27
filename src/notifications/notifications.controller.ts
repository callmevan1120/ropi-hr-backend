import { Controller, Get, Query } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notifService: NotificationsService) {}

  @Get()
  async getNotifications(@Query('employee_id') employee_id: string) {
    return this.notifService.getNotifications(employee_id);
  }
}