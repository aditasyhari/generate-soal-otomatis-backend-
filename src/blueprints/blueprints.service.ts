import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateBlueprintDto } from "./dto/create-blueprint.dto";

type ItemSpec = {
  type: "MCQ" | "ESSAY";
  cognitive: "LOTS" | "MOTS" | "HOTS";
  difficulty: "EASY" | "MEDIUM" | "HARD";
};

@Injectable()
export class BlueprintsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateBlueprintDto) {
    if (dto.mcqCount + dto.essayCount !== dto.total) {
      throw new BadRequestException("mcqCount + essayCount harus sama dengan total");
    }
    const cogSum = dto.cognitive.LOTS + dto.cognitive.MOTS + dto.cognitive.HOTS;
    if (cogSum !== dto.total) throw new BadRequestException("jumlah cognitive harus sama dengan total");
    const difSum = dto.difficulty.EASY + dto.difficulty.MEDIUM + dto.difficulty.HARD;
    if (difSum !== dto.total) throw new BadRequestException("jumlah difficulty harus sama dengan total");

    const doc = await this.prisma.document.findUnique({ where: { id: dto.documentId } });
    if (!doc) throw new BadRequestException("Document not found");
    if (doc.status !== "INDEXED") throw new BadRequestException(`Document harus INDEXED. Current: ${doc.status}`);

    return this.prisma.blueprint.create({
      data: {
        documentId: dto.documentId,
        title: dto.title,
        config: {
          total: dto.total,
          mcqCount: dto.mcqCount,
          essayCount: dto.essayCount,
          cognitive: dto.cognitive,
          difficulty: dto.difficulty,
          topKContext: dto.topKContext ?? 3,
        },
      },
    });
  }

  private expand<T extends string>(key: T, n: number) {
    return Array.from({ length: n }, () => key);
  }

  private shuffle<T>(arr: T[]) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async buildItems(blueprintId: string) {
    const bp = await this.prisma.blueprint.findUnique({ where: { id: blueprintId } });
    if (!bp) throw new BadRequestException("Blueprint not found");

    // bersihin items lama
    await this.prisma.blueprintItem.deleteMany({ where: { blueprintId } });

    const cfg = bp.config as any;
    const total: number = cfg.total;

    const types = this.shuffle([
      ...this.expand("MCQ", cfg.mcqCount),
      ...this.expand("ESSAY", cfg.essayCount),
    ]);

    const cogs = this.shuffle([
      ...this.expand("LOTS", cfg.cognitive.LOTS),
      ...this.expand("MOTS", cfg.cognitive.MOTS),
      ...this.expand("HOTS", cfg.cognitive.HOTS),
    ]);

    const difs = this.shuffle([
      ...this.expand("EASY", cfg.difficulty.EASY),
      ...this.expand("MEDIUM", cfg.difficulty.MEDIUM),
      ...this.expand("HARD", cfg.difficulty.HARD),
    ]);

    const items: ItemSpec[] = [];
    for (let i = 0; i < total; i++) {
      items.push({
        type: types[i],
        cognitive: cogs[i],
        difficulty: difs[i],
      });
    }

    await this.prisma.blueprintItem.createMany({
      data: items.map((it, idx) => ({
        blueprintId,
        no: idx + 1,
        type: it.type,
        cognitive: it.cognitive,
        difficulty: it.difficulty,
        objective: null,
        sourceChunkIds: null,
      })),
    });

    return this.prisma.blueprintItem.findMany({
      where: { blueprintId },
      orderBy: { no: "asc" },
    });
  }

  async get(blueprintId: string) {
    const bp = await this.prisma.blueprint.findUnique({
      where: { id: blueprintId },
      include: { items: { orderBy: { no: "asc" } } },
    });
    if (!bp) throw new BadRequestException("Blueprint not found");
    return bp;
  }
}