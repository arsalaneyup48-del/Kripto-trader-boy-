import { Module } from '@nestjs/common';
import { PatrolController } from './patrol.controller';
import { PatrolService } from './patrol.service';
import { LlmModule } from '../llm/llm.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [LlmModule, TelegramModule],
  controllers: [PatrolController],
  providers: [PatrolService],
})
export class PatrolModule {}
