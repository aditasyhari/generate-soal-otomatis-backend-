import { Body, Controller, Post } from "@nestjs/common";
import { ApiBody, ApiTags } from "@nestjs/swagger";
import { GeminiService } from "./gemini.service";

@ApiTags("gemini")
@Controller("gemini")
export class GeminiController {
  constructor(private gemini: GeminiService) {}

  @Post("test")
  @ApiBody({ schema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } })
  async test(@Body() body: { prompt: string }) {
    return this.gemini.generateText(body.prompt);
  }
}