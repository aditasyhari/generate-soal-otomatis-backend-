import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { RetrievalService } from "./retrieval.service";
import { RetrievalSearchDto } from "./dto/retrieval-search.dto";

@ApiTags("retrieval")
@Controller("retrieval")
export class RetrievalController {
  constructor(private readonly retrieval: RetrievalService) {}

  @Post("search")
  async search(@Body() dto: RetrievalSearchDto) {
    return this.retrieval.search(dto.documentId, dto.query, dto.topK ?? 5);
  }
}