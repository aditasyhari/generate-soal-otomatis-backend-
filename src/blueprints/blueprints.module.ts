import { Module } from '@nestjs/common';
import { BlueprintsController } from './blueprints.controller';
import { BlueprintsService } from './blueprints.service';

@Module({
  controllers: [BlueprintsController],
  providers: [BlueprintsService]
})
export class BlueprintsModule {}
