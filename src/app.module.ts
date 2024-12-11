import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from './datasource';
import { ProcessNinModule } from './process-nin/process-nin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule,
    ProcessNinModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
