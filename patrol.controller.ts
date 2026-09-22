import { Controller, Post, Headers, HttpCode, UnauthorizedException, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { PatrolService } from './patrol.service';

@ApiTags('Otomatik Devriye')
@Controller('patrol')
export class PatrolController {
  private readonly logger = new Logger(PatrolController.name);

  constructor(private readonly patrolService: PatrolService) {}

  @Post('run')
  @HttpCode(200)
  @ApiOperation({ summary: 'Otomatik piyasa taraması başlat (cron tarafından çağrılır)' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'API anahtarı' })
  async runPatrol(@Headers('x-api-key') apiKey: string): Promise<{ ok: boolean; message: string }> {
    const expectedKey = process.env.PATROL_API_KEY;
    if (!expectedKey || apiKey !== expectedKey) {
      throw new UnauthorizedException('Geçersiz API anahtarı');
    }

    this.logger.log('Otomatik devriye başlatıldı');
    const result = await this.patrolService.runPatrol();
    return { ok: true, message: result };
  }
}
