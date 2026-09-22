import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { TradeCard } from '../llm/llm.service';

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN') || '';
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  async onModuleInit() {
    const appOrigin = this.config.get<string>('APP_ORIGIN');
    if (appOrigin && !appOrigin.includes('localhost')) {
      await this.registerWebhook(appOrigin);
    } else {
      this.logger.warn('APP_ORIGIN localhost veya tanımsız — webhook kaydedilmedi');
    }
  }

  async registerWebhook(appOrigin: string): Promise<void> {
    const webhookUrl = new URL('/webhook/telegram', appOrigin).toString();
    try {
      const { data } = await axios.post(`${this.baseUrl}/setWebhook`, {
        url: webhookUrl,
        allowed_updates: ['message'],
      });
      this.logger.log(`Webhook kaydedildi: ${webhookUrl} — ${JSON.stringify(data)}`);
    } catch (err: any) {
      this.logger.error(`Webhook kayıt hatası: ${err.message}`);
    }
  }

  async sendMessage(chatId: string | number, text: string): Promise<void> {
    const cleanText = this.sanitizeForTelegram(text);
    try {
      await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text: cleanText,
        parse_mode: 'HTML',
      });
    } catch (err: any) {
      this.logger.error(`Mesaj gönderme hatası: ${err.message}`);
      // Fallback: send without HTML if parse fails
      try {
        const plain = cleanText.replace(/<[^>]+>/g, '');
        await axios.post(`${this.baseUrl}/sendMessage`, {
          chat_id: chatId,
          text: plain,
        });
      } catch (err2: any) {
        this.logger.error(`Fallback mesaj hatası: ${err2.message}`);
      }
    }
  }

  private sanitizeForTelegram(text: string): string {
    let s = text;
    // Fix literal \n that LLM sometimes puts in JSON strings
    s = s.replace(/\\n/g, '\n');
    // Convert Markdown bold **text** to HTML <b>text</b>
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    // Convert Markdown italic __text__ or _text_ to HTML <i>text</i>
    s = s.replace(/__(.+?)__/g, '<i>$1</i>');
    s = s.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<i>$1</i>');
    // Remove markdown headers (## etc)
    s = s.replace(/^#{1,6}\s+/gm, '');
    // Collapse excessive blank lines (max 2)
    s = s.replace(/\n{4,}/g, '\n\n\n');
    // Trim
    s = s.trim();
    return s;
  }

  formatTradeCard(card: TradeCard): string {
    return [
      '🎯 <b>İŞLEM KARTI</b>',
      '━━━━━━━━━━━━━━━',
      `📊 <b>Parite:</b> ${card.parity}`,
      `📈 <b>Yön:</b> ${card.direction}`,
      `⚡ <b>Kaldıraç:</b> ${card.leverage}x ISOLATED`,
      `💰 <b>Margin:</b> ${card.margin} USDT`,
      `🎯 <b>Giriş:</b> $${card.entry.toLocaleString()}`,
      `🛑 <b>Stop-Loss:</b> $${card.stopLoss.toLocaleString()}`,
      `✅ <b>Take-Profit:</b> $${card.takeProfit.toLocaleString()}`,
      `📊 <b>Güven Skoru:</b> ${card.confidence}/10`,
      `💎 <b>Potansiyel Kazanç:</b> +${card.potentialProfit.toFixed(2)} USDT (%${card.potentialProfitPct.toFixed(1)})`,
      `📝 <b>Gerekçe:</b> ${card.reasoning}`,
      '━━━━━━━━━━━━━━━',
    ].join('\n');
  }

  async getFileBase64(fileId: string): Promise<string> {
    try {
      const { data: fileData } = await axios.get(`${this.baseUrl}/getFile`, {
        params: { file_id: fileId },
      });
      const filePath = fileData.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
      const { data: imageBuffer } = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      return Buffer.from(imageBuffer).toString('base64');
    } catch (err: any) {
      this.logger.error(`Dosya indirme hatası: ${err.message}`);
      throw err;
    }
  }
}
