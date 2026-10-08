import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { AppModule } from './app.module';
import { QueueService } from './common/queue.service';
import { EvaluationService } from './evaluation/evaluation.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });
  app.set('trust proxy', 1);                       // behind nginx / ingress
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: false }));
  app.enableShutdownHooks();

  const doc = SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('ECEWS TalentScreen API').setVersion('1.0')
    .setDescription('AI-assisted recruitment decision support. All routes need a Bearer access token except /auth/login, /auth/refresh and /health.')
    .addBearerAuth().build());
  SwaggerModule.setup('api/docs', app, doc);

  if (config.queue.inline) {
    const q = app.get(QueueService); const ev = app.get(EvaluationService);
    q.setInlineHandler((job) => ev.process(job.evaluationId));
    Logger.warn('EVALUATE_INLINE=true: CVs are evaluated inside the API process. Use the worker service in production.', 'Bootstrap');
  }

  await app.listen(config.port, '0.0.0.0');
  Logger.log(`API listening on :${config.port} (docs at /api/docs)`, 'Bootstrap');
}
bootstrap();
