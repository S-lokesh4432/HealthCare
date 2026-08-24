/*
  Warnings:

  - Added the required column `bodyHtml` to the `NotificationLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `bodyText` to the `NotificationLog` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN     "bodyHtml" TEXT NOT NULL,
ADD COLUMN     "bodyText" TEXT NOT NULL;
