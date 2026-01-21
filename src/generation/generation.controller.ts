import { BadRequestException, Controller, Get, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { GenerationService } from "./generation.service";

@ApiTags("generation")
@Controller("generation")
export class GenerationController {
  constructor(private readonly service: GenerationService) {}

  @Post("blueprints/:id/run")
  run(@Param("id") blueprintId: string) {
    return this.service.startRun(blueprintId);
  }

  @Get("runs/:runId")
  getRun(@Param("runId") runId: string) {
    return this.service.getRun(runId);
  }

  @Get("runs/:runId/questions")
  getQuestions(@Param("runId") runId: string) {
    return this.service.getQuestions(runId);
  }
}