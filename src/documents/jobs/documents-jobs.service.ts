import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { JOB_DOCUMENT_PARSE, JOB_DOCUMENT_CHUNK, QUEUE_DOCUMENTS, QUEUE_INDEXING } from "../../queues/queue.constants";

@Injectable()
export class DocumentsJobsService {
  constructor(
    @InjectQueue(QUEUE_DOCUMENTS) private documentsQueue: Queue,
    @InjectQueue(QUEUE_INDEXING) private indexingQueue: Queue,
  ) {}

  enqueueParse(documentId: string, chainIndex = false) {
    return this.documentsQueue.add(
      JOB_DOCUMENT_PARSE,
      { documentId, chainIndex },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
    );
  }

  enqueueChunk(documentId: string, tokenTarget = 600, reset = true) {
    return this.indexingQueue.add(
      JOB_DOCUMENT_CHUNK,
      { documentId, tokenTarget, reset },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
    );
  }
}