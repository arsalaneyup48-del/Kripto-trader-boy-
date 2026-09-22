import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { MarketDataModule } from './market-data/market-data.module';
import { LlmModule } from './llm/llm.module';
import { TelegramModule } from './telegram/telegram.module';
import { PatrolModule } from './patrol/patrol.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    MarketDataModule,
    LlmModule,
    TelegramModule,
    PatrolModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
