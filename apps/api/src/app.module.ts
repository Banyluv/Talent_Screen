import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Db } from './common/db.service';
import { CryptoService } from './common/crypto.service';
import { AuditService } from './common/audit.service';
import { NotificationsService } from './common/notifications.service';
import { StorageService } from './common/storage.service';
import { QueueService } from './common/queue.service';
import { AuthGuard, Public } from './common/auth';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { AdminController } from './admin/admin.controller';
import { JobsController } from './jobs/jobs.controller';
import { CandidatesController } from './candidates/candidates.controller';
import { CandidatesService } from './candidates/candidates.service';
import { EvaluationService } from './evaluation/evaluation.service';
import { InterviewsController } from './interviews/interviews.controller';
import { ReportsController } from './reports/reports.controller';

@Controller('health')
class HealthController {
  constructor(private db: Db) {}
  @Public() @Get()
  async health() {
    await this.db.one('SELECT 1');
    return { status: 'ok', time: new Date().toISOString() };
  }
}

/** Services shared by the HTTP API and the background worker. */
export const CORE_PROVIDERS = [Db, CryptoService, AuditService, NotificationsService, StorageService, QueueService, EvaluationService];

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }])],
  controllers: [HealthController, AuthController, AdminController, JobsController, CandidatesController, InterviewsController, ReportsController],
  providers: [
    ...CORE_PROVIDERS, AuthService, CandidatesService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}

@Module({ providers: CORE_PROVIDERS })
export class WorkerModule {}
