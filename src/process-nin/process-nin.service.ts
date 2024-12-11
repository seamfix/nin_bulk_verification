import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { NinBulkVerifications } from 'src/entities/nin_bulk_verifications';
import { NinLookup } from 'src/entities/nin_lookup';
import { NinRecords } from 'src/entities/nin_records';
import { Not, Repository } from 'typeorm';
import {
  IBody,
  IBulkVerificationDetails,
  IBulkVerificationUpdate,
  IProcessBulk,
  IRequestBody,
} from './process-nin.dto';

@Injectable()
export class ProcessNinService {
  constructor(
    @InjectRepository(NinBulkVerifications)
    private readonly ninBulkRepository: Repository<NinBulkVerifications>,
    @InjectRepository(NinRecords)
    private readonly ninRecordsRepository: Repository<NinRecords>,
    @InjectRepository(NinLookup)
    private readonly ninLookupRepository: Repository<NinLookup>,
  ) {}

  delay = async (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  async initiateBulkRecordProcessing(body: IBody) {
    try {
      const bulkDetails = await this.ninBulkRepository.query(`
              select * from nin_bulk_verifications where pk = ${body.bulkFk}`);

      if (!bulkDetails[0]) {
        console.log(`Bulk with id ${body.bulkFk} not found`);
        return {
          code: 0,
          success: false,
          message: `Bulk with id ${body.bulkFk} not found`,
        };
      }

      if (
        bulkDetails[0].status?.toUpperCase() === 'COMPLETED' ||
        bulkDetails[0].status?.toUpperCase() === 'IN-PROGRESS'
      ) {
        Logger.log(`Bulk ${body.bulkFk} is ${bulkDetails[0].status}`);
        return {
          code: 0,
          success: false,
          message: `Bulk ${body.bulkFk} is ${bulkDetails[0].status}`,
        };
      }

      await this.ninBulkRepository.update(
        { pk: Number(body.bulkFk) },
        { status: 'IN-PROGRESS' },
      );
      console.log(`Processing bulk ${body.bulkFk}`);

      const payload = {
        bulkId: Number(body.bulkFk),
        mode: bulkDetails[0].service_mode,
      };

      this.processBulkRequest(payload);

      return {
        code: 0,
        success: true,
        message: `Request received successfully, bulk ${body.bulkFk} is in progress`,
      };
    } catch (error) {
      console.log(
        `Error occurred for bulk ${body.bulkFk} with message ${error.message}`,
      );
      return {
        code: -1,
        success: false,
        message: error.message || 'Internal Server Error',
      };
    }
  }

  async processBulkRequest(body: IProcessBulk) {
    try {
      let isThereStilUnprocessedData = await this.isThereStillUnprocessedData(
        body.bulkId,
      );

      while (isThereStilUnprocessedData) {
        // Default to 500 if not set
        const batchSize = process.env.BATCH_SIZE
          ? parseInt(process.env.BATCH_SIZE, 10)
          : 500;

        // Select pending invocations with row locking and skip locked
        let invocationDetails = await this.getUnprocessedRecordsByBatch(
          body,
          batchSize,
        );

        const apiRequests: IRequestBody[] = invocationDetails.map((row) => ({
          id: row.search_parameter, // Map 'search_parameter' to 'id'
          invocationId: row.pk,     // Map 'pk' to 'invocationId'
        }));

        await Promise.allSettled(
          apiRequests.map(async (request) => {
            try {
              await this.processBulkRecord(request, body.mode);
            } catch (error) {
              console.error(
                `Failed processing search parameter ${request.id} with invocation ID ${request.invocationId} with error message  ${error.message}`,
                error,
              );
            }
          }),
        );
        await this.delay(Number(process.env.DELAY_TIMEOUT));

        isThereStilUnprocessedData = await this.isThereStillUnprocessedData(
          body.bulkId,
        );
      }
      if (!isThereStilUnprocessedData) {
        console.log(`Finished processing bulk with id ${body.bulkId}`);
        await this.completeVerification(body.bulkId, body.mode);
        return;
      }
    } catch (error) {
      console.log(
        `Error processing bulk request for bulk ${body.bulkId} with message ${error.message}`,
      );
    }
  }

  async isThereStillUnprocessedData(pk: number): Promise<boolean> {
    const total = await this.ninRecordsRepository.query(
      `SELECT COUNT(*) FROM nin_records WHERE bulk_fk = $1 AND (job_status IS NULL OR job_status = 'PENDING')`,
      [pk],
    );

    const totalInvocations = parseInt(total[0].count, 10);

    const result = !!totalInvocations;
    return result;
  }

  async getUnprocessedRecordsByBatch(body: IProcessBulk, batchSize: number) {
    const query = `SELECT pk, search_parameter
            FROM nin_records 
            WHERE (job_status IS NULL OR job_status = 'PENDING') 
            AND bulk_fk = $1
            ORDER BY created_date ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED`;

    let invocationDetails = await this.ninRecordsRepository.query(query, [
      body.bulkId,
      batchSize,
    ]);

    const invocationPks = invocationDetails.map((row) => row.pk);

    const qUpdateInvocationsStatus = `UPDATE nin_records
                                              SET job_status = 'IN_PROGRESS'
                                              WHERE pk = ANY($1::int[])`;
    await this.ninRecordsRepository.query(qUpdateInvocationsStatus, [
      invocationPks,
    ]);
    return invocationDetails;
  }

  async processBulkRecord(record: IRequestBody, mode: string) {
    const { id, invocationId } = record;

    // Check lookup table
    const lookupID = await this.findInLookupTable(id);
    if (lookupID) {
      console.log(`NIN ${id} found in lookup table. Skipping API call.`);

      // Hardcoded statuses for records found in the lookup
      await this.updateInvocationTable(
        invocationId,
        'COMPLETED', // job_status
        'SUCCESSFUL', // transaction_status
        'SEARCH_FROM_DB', // retrieval_mode
        'VERIFIED', // status
      );
      return;
    }

    // If not in lookup table, make API call
    try {
      let response;
      if (mode.toLowerCase() === 'live') {
        response = await this.callThirdPartyAPI({
          id: id,
          isSubjectConsent: 'true',
        });
      } else {
        response = await this.fetchMockResponse({
          id: id,
          isSubjectConsent: 'true',
        });
      }

      console.log(
        `${mode.toLowerCase() === 'live' ? 'Live' : 'Mock'} Response for search parameter ${id} with response status: ${response === null ? 'null' : response.status}`,
      );

      if (response?.status === 200 && response?.data?.success && response?.data?.statusCode === 200) {
        const data = response.data.data;

        if (data.status === 'found') {
          const updateLookupTableQuery = `
          INSERT INTO nin_lookup (
            "search_parameter", "first_name", "middle_name", "surname", "gender", "mobile", "date_of_birth", "photo"
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT ("search_parameter") DO UPDATE
          SET "first_name" = EXCLUDED."first_name",
              "middle_name" = EXCLUDED."middle_name",
              "surname" = EXCLUDED."surname",
              "gender" = EXCLUDED."gender",
              "mobile" = EXCLUDED."mobile",
              "date_of_birth" = EXCLUDED."date_of_birth",
              "photo" = EXCLUDED."photo";
        `;

          // Insert or update the lookup table with the API response data
          await this.ninLookupRepository.query(updateLookupTableQuery, [
            id,
            data.firstName,
            data.middleName,
            data.lastName,
            data.gender,
            data.mobile,
            data.dateOfBirth,
            data.image,
          ]);

          // Update the invocation table with success details
          await this.updateInvocationTable(
            invocationId,
            'COMPLETED', // job_status
            'SUCCESSFUL', // transaction_status
            'THIRD_PARTY', // retrieval_mode
            'VERIFIED', // status
          );
          return;
        } else {
          await this.updateInvocationTable(
            invocationId,
            'COMPLETED', // job_status
            'SUCCESSFUL', // transaction_status
            'THIRD_PARTY', // retrieval_mode
            'NOT VERIFIED', // status
            data.status,
          );
          return;
        }
      } else if (response?.status === 400) {
        await this.updateInvocationTable(
          invocationId,
          'COMPLETED', // job_status
          'SUCCESSFUL', // transaction_status
          'THIRD_PARTY', // retrieval_mode
          'NOT VERIFIED', // status
          response.data.message, // failure_reason
        );
        return;
      } else {
        await this.updateInvocationTable(
          invocationId,
          'COMPLETED', // job_status
          'FAILED', // transaction_status
          'THIRD_PARTY', // retrieval_mode
          'FAILED', // status
          'FAILED', // failure_reason
        );
        return;
      }
    } catch (error) {
      console.log(
        `Failed processing NIN ${id} with invocation ID ${invocationId}: error: ${error.message}`,
      );

      // Handling failures
      await this.updateInvocationTable(
        invocationId,
        'COMPLETED', // job_status
        'SUCCESSFUL', // transaction_status
        'THIRD_PARTY', // retrieval_mode
        'NOT VERIFIED', // status
        error.message, // failure_reason
      );
    }
  }

  async findInLookupTable(uin: string) {
    const checkUinQuery = `SELECT search_parameter FROM nin_lookup WHERE search_parameter = $1 LIMIT 1`;
    const result = await this.ninLookupRepository.query(checkUinQuery, [uin]);
    return result.length > 0 ? result[0].search_parameter : null;
  }

  async updateInvocationTable(
    invocationId: string,
    jobStatus: string,
    transactionStatus: string,
    retrievalMode: string,
    status: string,
    failureReason = null,
  ) {
    const updateQuery = `
      UPDATE nin_records
      SET job_status = $1,
      transaction_status = $3,
      status = $2,
          retrieval_mode = $4,
          failure_reason = $5,
          modified_date = $7
      WHERE pk = $6
    `;
    try {
      await this.ninRecordsRepository.query(updateQuery, [
        jobStatus,
        status,
        transactionStatus,
        retrievalMode,
        failureReason,
        invocationId,
        new Date(),
      ]);
    } catch (error) {
      console.log(
        `Error updating invocation table for invocation id ${invocationId} with error message ${error.message}`,
      );
    }
  }

  async callThirdPartyAPI(apiRequestPayload: {
    id: string;
    isSubjectConsent: string;
  }) {
    try {
      const url = process.env.YOUVERIFY_API_URL_V2;
      const token = process.env.YOUVERIFY_API_KEY_V2;

      const response = await axios.post(url, apiRequestPayload, {
        headers: {
          'Content-Type': 'application/json',
          token: token,
        },
      });
      return response;
    } catch (err) {
      console.log(`API call error: ${err.response?.data} OR ${err.message}`);
      return null;
    }
  }

  async fetchMockResponse(apiRequestPayload: {
    id: string;
    isSubjectConsent: string;
  }) {
    // Mock Success Response
    const foundSuccessResponse = {
      data: {
        success: true,
        statusCode: 200,
        data: {
          firstName: 'John',
          middleName: 'Leo',
          lastName: 'Doe',
          image: 'https://example.com/image.jpg',
          mobile: '123-456-7890',
          dateOfBirth: '1980-01-01',
          status: 'found',
          idNumber: '9876543210',
          gender: 'Male',
        },
        message: 'success',
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    };

    const notFoundSuccessResponse = {
      data: {
        success: true,
        statusCode: 200,
        data: {
          firstName: null,
          middleName: null,
          lastName: null,
          image: null,
          mobile: null,
          dateOfBirth: null,
          status: 'not_found',
          idNumber: null,
          gender: null,
        },
        message: 'success',
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    };

    // Mock Failure Response (400)
    const failureResponse = {
      data: {
        success: false,
        statusCode: 400,
        message:
          "ValidationError: 'id' length must be at least 10 characters long",
      },
      status: 400,
      statusText: 'BAD REQUEST',
      headers: {},
      config: {},
    };

    // Mock Error Response (500)
    const errorResponse = {
      message: 'Network Error',
      response: null,
      status: 500,
    };

    let randomResponse: any;
    if (apiRequestPayload?.id.length <= 9) {
      // "id" is shorter than 10 characters, simulate failure
      randomResponse = failureResponse;
    } else {
      // Randomly decide if it should be a success response or an error
      const randomChance = Math.random();

      if (randomChance > 0.9) {
        // 10% chance of a 500 error response
        randomResponse = errorResponse;
      } else {
        // 90% chance for either found or not found success response
        randomResponse =
          randomChance > 0.5 ? foundSuccessResponse : notFoundSuccessResponse;
      }
    }

    const delay = Math.floor(Math.random() * (100 - 10 + 1)) + 10; // Random delay between 10ms and 100ms

    // Return the response after the delay
    await new Promise((resolve) => setTimeout(resolve, delay));
    return randomResponse;
  }

  async completeVerification(bulkId: number, mode: string) {
    try {
      const incompleteCount = await this.ninRecordsRepository.count({
        where: {
          bulkFk: { bulk_id: bulkId.toString() },
          job_status: Not('COMPLETED'),
        },
      });

      if (incompleteCount === 0) {
        // All records have been completed, update bulk verification table
        const currentDate = new Date();
        const bulkVerificationUpdate: IBulkVerificationUpdate = {
          status: 'COMPLETED',
          completion_date: currentDate.toISOString(),
          modified_date: currentDate.toISOString(),
          expiry_date: new Date(
            currentDate.getTime() + 2 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        };

        await this.ninBulkRepository.update(
          { pk: bulkId },
          bulkVerificationUpdate,
        );

        const bulkDetails = await this.ninBulkRepository.query(`
            select * from nin_bulk_verifications  
            where pk = ${bulkId}`);

        if (mode === 'live') {
          // send email endpoint
          await this.sendEmail(`${bulkId}`);
        }
        if (bulkDetails[0]) {
          console.log(`Generating report for bulk with id ${bulkId}`);
          await this.generateReportAndUploadToS3({
            ...bulkDetails[0],
            wrapperFk: bulkDetails[0].wrapper_fk,
          });
        }
      }

      return incompleteCount;
    } catch (error) {
      console.error(error);
    }
  }

  async sendEmail(bulkId: string) {
    const payload = {
      bulkId,
    };

    const headersRequest = {
      Accept: 'application/json',
    };

    const url = `${process.env.NODE_SERVICE}/bulk-verification/bulk-notification-mail`;

    await axios.post(url, payload, {
      headers: headersRequest,
    });
  }

  async generateReportAndUploadToS3(body: IBulkVerificationDetails) {
    const payload = {
      wrapperFk: body.wrapperFk,
      pk: body.pk,
      filename: body.file_name,
    };

    const headersRequest = {
      Accept: 'application/json',
    };

    const url = `${process.env.NODE_SERVICE}/bulk-verification/upload-bulk-job-result`;

    await axios.post(url, payload, {
      headers: headersRequest,
    });
  }
}
