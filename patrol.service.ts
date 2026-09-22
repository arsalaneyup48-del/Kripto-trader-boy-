import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class PatrolService {
  private readonly logger = new Logger(PatrolService.name);
  private readonly patrolChatId: string;
  private readonly autoPatrolEnabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly telegram: TelegramService,
  ) {
    this.patrolChatId = this.config.get<string>('PATROL_CHAT_ID') || '';
    // PATROL_AUTO=false ile kapatılabilir; varsayılan açık.
    this.autoPatrolEnabled = this.config.get<string>('PATROL_AUTO') !== 'false';
  }

  // Her 15 dakikada bir kendi kendine tarama yapar — dışarıdan cron'a gerek yok.
  // Aralığı değiştirmek için CronExpression.EVERY_10_MINUTES gibi bir değerle değiştir.
  @Cron(CronExpression.EVERY_15_MINUTES)
  async handleAutoPatrol(): Promise<void> {
    if (!this.autoPatrolEnabled) return;
    try {
      const result = await this.runPatrol();
      this.logger.log(`Otomatik devriye (cron): ${result}`);
    } catch (err: any) {
      this.logger.error(`Otomatik devriye hatası: ${err.message}`);
    }
  }

  async runPatrol(): Promise<string> {
    // Collect recipients: env override OR all known chats
    let recipients: string[] = [];
    if (this.patrolChatId) {
      recipients = [this.patrolChatId];
    } else {
      const chats = await this.prisma.telegram_chat.findMany();
      recipients = chats.map((c) => c.chat_id);
    }

    if (recipients.length === 0) {
      this.logger.warn('Kayıtlı chat yok — devriye atlandı (botla bir kez konuşun)');
      return 'Kayıtlı chat yok';
    }

    // Run LLM patrol scan
    const response = await this.llm.patrolScan();

    if (!response.tradeCard) {
      this.logger.log('Devriye: işlem fırsatı bulunamadı');
      return 'Fırsat yok';
    }

    const card = response.tradeCard;

    // Check spam prevention
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const recentAlert = await this.prisma.sent_alert.findFirst({
      where: {
        parity: card.parity,
        direction: card.direction,
        sent_at: { gte: fourHoursAgo },
      },
    });

    if (recentAlert) {
      this.logger.log(`Spam önleme: ${card.parity} ${card.direction} zaten son 4 saatte gönderildi`);
      return `${card.parity} zaten gönderildi`;
    }

    // Only send if confidence >= 7
    if (card.confidence < 7) {
      this.logger.log(`Düşük güven skoru (${card.confidence}/10), atlandı`);
      return `Güven skoru düşük: ${card.confidence}/10`;
    }

    // Send alert to all recipients (respecting per-chat kill switch)
    const formattedCard = this.telegram.formatTradeCard(card);
    const alertMsg = `🔔 <b>OTOMATİK TARAMA ALARMI</b>\n\n${response.text ? response.text + '\n\n' : ''}${formattedCard}`;
    let sentCount = 0;
    for (const chatId of recipients) {
      const settings = await this.prisma.user_settings.findUnique({
        where: { user_id: chatId },
      });
      if (settings?.is_kill_switch_active) {
        this.logger.log(`Kill switch aktif (${chatId}) — atlandı`);
        continue;
      }
      await this.telegram.sendMessage(chatId, alertMsg);
      sentCount++;
    }

    if (sentCount === 0) {
      return 'Tüm alıcılarda kill switch aktif';
    }

    // Record sent alert
    await this.prisma.sent_alert.create({
      data: {
        parity: card.parity,
        direction: card.direction,
        confidence: card.confidence,
      },
    });

    this.logger.log(`Alarm gönderildi: ${card.parity} ${card.direction} (güven: ${card.confidence})`);
    return `Alarm gönderildi: ${card.parity} ${card.direction}`;
  }
}
