import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [MarketDataModule],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
